'use strict';

const crypto = require('crypto');
const { createConnection, connectAndWait, emitWithAck, attachReconnectionHandlers } = require('./connection');
const { sendFile } = require('./sender');
const { listFiles } = require('../common/files');
const { ConcurrencyPool } = require('../common/concurrency');
const { EVENTS, CHUNK_SIZE } = require('../common/protocol');
const {
  isRetriable,
  withRetry,
  InFlightTracker,
  ConnectionStateMachine,
  setupSigintHandler,
  writeFailureReport
} = require('./resilience');
const { ProgressRenderer } = require('./progress');
const { Logger } = require('./logger');

/**
 * Format bytes into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Execute dry-run mode: list files that would be transferred, then exit.
 * No network connection is made.
 *
 * @param {string} folder - Absolute path to source folder
 * @param {object} options - Transfer options
 * @param {Logger} logger - Logger instance
 * @returns {{succeeded: Array, failed: Array, skipped: number, exitCode: number}}
 */
function dryRun(folder, options, logger) {
  const fileList = listFiles(folder);

  logger.info(`Source: ${folder}`);
  logger.info(`Found ${fileList.length} file(s)`);

  if (fileList.length === 0) {
    console.log('[dry-run] No files to transfer.');
    return { succeeded: [], failed: [], skipped: 0, exitCode: 0 };
  }

  // In dry-run mode, all files would be transferred (no server to check resume state)
  const totalBytes = fileList.reduce((sum, f) => sum + f.size, 0);

  console.log(`\n[dry-run] Would transfer ${fileList.length} file(s) (${formatSize(totalBytes)}):\n`);

  // Show files — up to 50 unless verbose
  const limit = options.verbose ? fileList.length : Math.min(50, fileList.length);
  for (let i = 0; i < limit; i++) {
    const f = fileList[i];
    const sizeStr = formatSize(f.size).padStart(10);
    console.log(`  ${f.relativePath.padEnd(50)} ${sizeStr}`);
  }
  if (fileList.length > limit) {
    console.log(`  ... and ${fileList.length - limit} more`);
  }

  console.log(`\n[dry-run] Total: ${fileList.length} files, ${formatSize(totalBytes)}`);

  return { succeeded: [], failed: [], skipped: 0, exitCode: 0 };
}

/**
 * Run the full send orchestration: connect, init session, transfer files.
 * Phase 5: Supports resume — files already complete on receiver are skipped,
 * partially-transferred files resume from their byte offset.
 * Phase 6: Resilience — per-file retry, reconnection handling, SIGINT, stall detection.
 * Phase 8: Dry-run, verbose/quiet, log-file, global-timeout, configurable chunk-timeout.
 *
 * @param {object} params
 * @param {string} params.address - Server IP or hostname
 * @param {number} params.port - Server port
 * @param {string} params.folder - Absolute path to folder to send
 * @param {object} params.options - Transfer options
 * @param {number} params.options.concurrency - Number of parallel file transfers
 * @param {boolean} params.options.compress - Enable Brotli compression
 * @param {boolean} params.options.checksum - Enable MD5 verification
 * @param {number} params.options.retries - Max retries per file
 * @param {boolean} params.options.resume - Enable resume capability
 * @param {number} [params.options.stallTimeout] - Stall detection timeout in ms (default: 30000)
 * @param {number} [params.options.graceTimeout] - SIGINT grace period in ms (default: 10000)
 * @param {number} [params.options.timeout] - Per-chunk ack timeout in ms (default: 30000)
 * @param {number} [params.options.globalTimeout] - Total transfer timeout in ms (0 = no limit)
 * @param {boolean} [params.options.dryRun] - Dry-run mode
 * @param {boolean} [params.options.verbose] - Verbose output
 * @param {boolean} [params.options.quiet] - Quiet output
 * @param {string|null} [params.options.logFile] - Log file path
 * @returns {Promise<{succeeded: any[], failed: Array<{index: number, error: Error}>, skipped: number, exitCode: number}>}
 */
async function runSendSession(params) {
  const { address, port, folder, options } = params;
  const opts = {
    concurrency: options.concurrency || 5,
    compress: options.compress || false,
    checksum: options.checksum !== false,
    retries: options.retries != null ? options.retries : 3,
    resume: options.resume !== false,
    stallTimeout: options.stallTimeout || 30000,
    graceTimeout: options.graceTimeout || 10000,
    timeout: options.timeout != null ? options.timeout : 30000,
    globalTimeout: options.globalTimeout != null ? options.globalTimeout : 0,
    dryRun: options.dryRun || false,
    verbose: options.verbose || false,
    quiet: options.quiet || false,
    logFile: options.logFile || null
  };

  // Initialize logger (always writes to log file at debug level, console respects verbosity)
  const logger = new Logger({
    logFile: opts.logFile,
    verbose: opts.verbose,
    quiet: opts.quiet
  });

  // Total attempts = 1 initial + retries
  const maxAttempts = opts.retries + 1;

  logger.info(`Options: ${JSON.stringify(opts, null, 2)}`);
  logger.info(`Folder: ${folder}`);
  logger.info(`Server: ${address}:${port}`);

  // --- Dry-run mode: list files and exit ---
  if (opts.dryRun) {
    const result = dryRun(folder, opts, logger);
    logger.close();
    return result;
  }

  // 1. List files
  const fileList = listFiles(folder);
  logger.info(`Found ${fileList.length} file(s) to transfer.`);

  if (fileList.length === 0) {
    logger.info('No files to transfer.');
    logger.close();
    return { succeeded: [], failed: [], skipped: 0, exitCode: 0 };
  }

  // 1b. Set up progress renderer (suppressed in quiet mode)
  let progress = null;
  if (!opts.quiet) {
    progress = new ProgressRenderer({
      total: fileList.length,
      stream: process.stdout
    });
  }

  // Wire logger to progress renderer for above-bar output
  if (progress) {
    logger.setProgress(progress);
  }

  const transferStartTime = Date.now();

  // 2. Connect to server with reconnection support
  const socket = createConnection(address, port, {
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000
  });

  // 3. Set up connection state machine
  const stateMachine = new ConnectionStateMachine({
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000
  });

  // 4. Set up in-flight tracker
  const inflight = new InFlightTracker();

  // 5. Set up concurrency pool
  let skippedCount = 0;
  const pool = new ConcurrencyPool(opts.concurrency, {
    onTaskComplete: (result, _index) => {
      if (result && result.status === 'skipped') {
        skippedCount++;
      }
    },
    onTaskError: (err, index) => {
      logger.error(`Task ${index} failed: ${err.message}`);
    }
  });

  // Track session ID for re-init on reconnection
  const sessionId = crypto.randomUUID();
  let sessionReady = false;

  // Failure accumulator for final report
  const failedFiles = [];

  // 6. Attach reconnection handlers
  const cleanupReconnection = attachReconnectionHandlers(socket, {
    onDisconnect: (reason) => {
      logger.warn(`Disconnected: ${reason}`);
      stateMachine.handleDisconnect();
      // Pause pool — no new files start
      pool.pause();
      // Mark in-flight files as paused
      inflight.pauseAll();
    },
    onReconnectAttempt: (attempt) => {
      logger.info(`Reconnection attempt ${attempt}...`);
      stateMachine.handleReconnectAttempt();
    },
    onReconnect: () => {
      logger.info('Reconnected successfully.');
      stateMachine.handleConnected();

      // Re-initialize session on the new connection
      emitWithAck(socket, EVENTS.SESSION_INIT, {
        sessionId,
        compress: opts.compress,
        checksum: opts.checksum,
        resume: opts.resume
      }, opts.timeout).then((ack) => {
        if (ack && ack.ok) {
          sessionReady = true;
          // Clear paused entries — retry loops will handle re-sending naturally
          inflight.clearPaused();
        }
        // Resume pool regardless — let in-flight retry loops proceed
        pool.resume();
      }).catch((err) => {
        logger.error(`Session re-init failed: ${err.message}`);
        stateMachine.handleReconnectFailed();
        // Resume pool so tasks fail naturally with connection errors (no permanent hang)
        pool.resume();
      });
    },
    onReconnectFailed: () => {
      logger.error('All reconnection attempts exhausted. Connection dead.');
      stateMachine.handleReconnectFailed();
    }
  });

  // 7. SIGINT handler setup
  let sigintCleanup = null;
  let shutdownResult = null;

  const sigint = setupSigintHandler({
    pool,
    inflight,
    socket,
    graceTimeout: opts.graceTimeout,
    onShutdown: (result) => {
      shutdownResult = result;
    }
  });
  sigintCleanup = sigint.cleanup;

  // 8. Global timeout setup
  let globalTimer = null;
  let globalTimedOut = false;

  if (opts.globalTimeout > 0) {
    globalTimer = setTimeout(() => {
      globalTimedOut = true;
      logger.error(`Global timeout reached (${opts.globalTimeout}ms). Aborting remaining transfers.`);
      // Pause the pool to stop new tasks
      pool.pause();
      // Mark all in-flight as failed
      inflight.pauseAll();
    }, opts.globalTimeout);
  }

  // 9. Connect
  try {
    await connectAndWait(socket);
  } catch (err) {
    if (globalTimer) clearTimeout(globalTimer);
    if (sigintCleanup) sigintCleanup();
    cleanupReconnection();
    logger.close();
    // Fatal: cannot connect at all → exit code 2
    const connError = new Error(`Connection failed: ${err.message}`);
    connError.exitCode = 2;
    throw connError;
  }

  stateMachine.handleConnected();
  logger.info(`Connected to ${address}:${port}`);

  try {
    // 10. Initialize session
    const sessionAck = await emitWithAck(socket, EVENTS.SESSION_INIT, {
      sessionId,
      compress: opts.compress,
      checksum: opts.checksum,
      resume: opts.resume
    }, opts.timeout);

    if (!sessionAck || !sessionAck.ok) {
      throw new Error('Session initialization failed');
    }
    sessionReady = true; // eslint-disable-line no-unused-vars -- state flag for session tracking, written on reconnect
    logger.info('Server acknowledged session.');

    // 11. Create tasks with per-file retry wrapping
    stateMachine.startTransferring();

    const tasks = fileList.map((fileInfo) => {
      return createFileTask(socket, fileInfo, opts, maxAttempts, inflight, failedFiles, sigint.isShuttingDown, progress, logger, () => globalTimedOut);
    });

    // 12. Run all tasks with isolation
    const { succeeded, failed: _failed } = await pool.runAllSettled(tasks);

    // Clear global timeout
    if (globalTimer) clearTimeout(globalTimer);

    // If global timeout triggered, write failure report for remaining files
    if (globalTimedOut) {
      const remaining = fileList.filter((f) => {
        const wireKey = f.relativePath;
        return !succeeded.some((s) => s && s.wireKey === wireKey) &&
               !failedFiles.some((ff) => ff.path === wireKey);
      });
      for (const f of remaining) {
        failedFiles.push({
          path: f.relativePath,
          error: 'Global timeout exceeded',
          attempts: 0
        });
      }
    }

    // Check if we died during transfer
    if (stateMachine.isDead) {
      // Connection permanently lost
      const report = buildReport(fileList, succeeded, failedFiles);
      if (report.failures.length > 0) {
        const reportPath = writeFailureReport(process.cwd(), report);
        logger.error(`Failure report written to: ${reportPath}`);
      }
      logger.error('Connection lost permanently.');
      printSummary(progress, opts.quiet, fileList, succeeded, skippedCount, failedFiles, transferStartTime);
      logger.close();
      return { succeeded, failed: failedFiles, skipped: skippedCount, exitCode: 2 };
    }

    // Check if shutdown was triggered
    if (shutdownResult) {
      const report = buildReport(fileList, succeeded, failedFiles);
      if (report.failures.length > 0) {
        const reportPath = writeFailureReport(process.cwd(), report);
        logger.error(`Failure report written to: ${reportPath}`);
      }
      logger.info(`Shutdown: ${succeeded.length} completed, ${shutdownResult.snapshot.length} in progress.`);
      printSummary(progress, opts.quiet, fileList, succeeded, skippedCount, failedFiles, transferStartTime);
      logger.close();
      return { succeeded, failed: failedFiles, skipped: skippedCount, exitCode: failedFiles.length > 0 ? 1 : 0 };
    }

    stateMachine.stopTransferring();

    // 13. Signal transfer complete
    const totalBytes = fileList.reduce((sum, f) => sum + f.size, 0);
    try {
      await emitWithAck(socket, EVENTS.TRANSFER_COMPLETE, {
        sessionId,
        totalFiles: fileList.length,
        totalBytes,
        skipped: skippedCount
      }, opts.timeout);
    } catch (_) {
      // Non-critical: transfer-complete ack failure doesn't affect data integrity
    }

    // 14. Determine exit code and write failure report
    let exitCode = 0;
    if (failedFiles.length > 0) {
      exitCode = 1;
      const report = buildReport(fileList, succeeded, failedFiles);
      const reportPath = writeFailureReport(process.cwd(), report);
      logger.error(`Failure report written to: ${reportPath}`);
    }

    // 15. Print final progress summary
    printSummary(progress, opts.quiet, fileList, succeeded, skippedCount, failedFiles, transferStartTime);

    if (failedFiles.length > 0) {
      for (const f of failedFiles) {
        logger.error(`[failed] ${f.path}: ${f.error}`);
      }
    }

    logger.close();
    return { succeeded, failed: failedFiles, skipped: skippedCount, exitCode };

  } finally {
    // Cleanup
    if (globalTimer) clearTimeout(globalTimer);
    if (sigintCleanup) sigintCleanup();
    cleanupReconnection();
    socket.disconnect();
  }
}

/**
 * Print the final summary line.
 * In quiet mode, prints a minimal summary to stdout.
 * Otherwise delegates to progress.finish().
 *
 * @param {ProgressRenderer|null} progress
 * @param {boolean} quiet
 * @param {Array} fileList
 * @param {Array} succeeded
 * @param {number} skippedCount
 * @param {Array} failedFiles
 * @param {number} transferStartTime
 */
function printSummary(progress, quiet, fileList, succeeded, skippedCount, failedFiles, transferStartTime) {
  const elapsed = Date.now() - transferStartTime;
  const totalBytes = fileList.reduce((sum, f) => sum + f.size, 0);
  const transferredCount = succeeded.length;
  const throughput = elapsed > 0 ? (transferredCount + skippedCount + failedFiles.length) / (elapsed / 1000) : 0;

  if (progress) {
    progress.finish({
      transferred: transferredCount,
      skipped: skippedCount,
      failed: failedFiles.length,
      totalBytes,
      elapsed,
      throughput
    });
  } else if (quiet) {
    // Minimal summary for quiet/cron mode
    const status = failedFiles.length > 0 ? '\u2717' : '\u2713';
    console.log(`${status} ${transferredCount} transferred, ${skippedCount} skipped, ${failedFiles.length} failed | ${formatSize(totalBytes)} | ${(elapsed / 1000).toFixed(1)}s`);
  }
}

/**
 * Create a per-file transfer task with retry logic.
 * Each task wraps sendFile in withRetry(), isolating failures from other tasks.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {object} fileInfo - File metadata from listFiles
 * @param {object} opts - Transfer options
 * @param {number} maxAttempts - Total attempts per file (1 = no retries)
 * @param {InFlightTracker} inflight - In-flight tracker
 * @param {Array} failedFiles - Accumulator for permanent failures
 * @param {() => boolean} [isShuttingDown] - Check if shutdown in progress
 * @param {ProgressRenderer|null} [progress] - Progress renderer instance
 * @param {Logger} [logger] - Logger instance
 * @param {() => boolean} [isTimedOut] - Check if global timeout reached
 * @returns {() => Promise<any>}
 */
function createFileTask(socket, fileInfo, opts, maxAttempts, inflight, failedFiles, isShuttingDown, progress, logger, isTimedOut) {
  return async () => {
    const wireKey = fileInfo.relativePath;
    let attemptCount = 0;

    // Check global timeout before starting
    if (isTimedOut && isTimedOut()) {
      const err = new Error('Global timeout exceeded');
      failedFiles.push({ path: wireKey, error: err.message, attempts: 0 });
      throw err;
    }

    try {
      const result = await withRetry(
        async () => {
          attemptCount++;

          // Check global timeout before each attempt
          if (isTimedOut && isTimedOut()) {
            const err = new Error('Global timeout exceeded');
            err.nonRetriable = true;
            throw err;
          }

          // Register in-flight before each attempt
          inflight.register(wireKey, {
            absolutePath: fileInfo.absolutePath,
            size: fileInfo.size,
            attempt: attemptCount
          });

          // Verbose: log file start
          if (opts.verbose && logger) {
            logger.debug(`[start] ${wireKey} (${formatSize(fileInfo.size)})`);
          }

          const fileStartTime = Date.now();

          try {
            const sendResult = await sendFile(socket, fileInfo, {
              compress: opts.compress,
              checksum: opts.checksum,
              chunkSize: CHUNK_SIZE,
              resume: opts.resume,
              ackTimeout: opts.timeout
            }, {
              onChunkSent: (fileKey, chunkIndex, totalChunks, bytesSent) => {
                inflight.updateProgress(wireKey, bytesSent);
                if (progress) progress.onChunkSent(wireKey, bytesSent);
              },
              onFileComplete: (fileKey, status) => {
                const elapsed = ((Date.now() - fileStartTime) / 1000).toFixed(1);
                if (status === 'verified' || status === 'ok') {
                  if (progress) progress.onFileComplete(wireKey);
                  if (opts.verbose && logger) {
                    logger.debug(`[done]  ${wireKey} (${formatSize(fileInfo.size)}, ${elapsed}s)`);
                  }
                } else if (status === 'skipped') {
                  if (progress) progress.onFileSkipped(wireKey);
                  if (opts.verbose && logger) {
                    logger.debug(`[skip]  ${wireKey} (already complete)`);
                  }
                } else {
                  if (progress) progress.warn(`${fileKey} — ${status}`);
                }
              },
              onFileSkipped: (_fileKey) => {
                if (progress) progress.onFileSkipped(wireKey);
                if (opts.verbose && logger) {
                  logger.debug(`[skip]  ${wireKey} (already complete)`);
                }
              }
            });

            // Success — remove from in-flight
            inflight.complete(wireKey);
            return sendResult;
          } catch (err) {
            // Remove from in-flight on failure (will be re-registered on retry)
            inflight.fail(wireKey);

            if (opts.verbose && logger) {
              logger.debug(`[fail]  ${wireKey} (${err.message})`);
            }

            throw err;
          }
        },
        {
          maxAttempts,
          shouldRetry: (err) => {
            if (err.nonRetriable) return false;
            return isRetriable(err);
          },
          isAborted: () => {
            if (isShuttingDown && isShuttingDown()) return true;
            if (isTimedOut && isTimedOut()) return true;
            return false;
          },
          onRetry: (err, attempt, delay) => {
            const msg = `${wireKey} — retry ${attempt}/${maxAttempts} after ${Math.round(delay)}ms (${err.message})`;
            if (opts.verbose && logger) {
              logger.debug(`[retry] ${wireKey} (attempt ${attempt}/${maxAttempts}, delay ${Math.round(delay)}ms)`);
            }
            if (progress) {
              progress.warn(msg);
            } else if (!opts.quiet) {
              console.warn(`[retry] ${msg}`);
            }
          },
          backoff: {
            baseDelay: 1000,
            maxDelay: 30000,
            maxJitter: 500
          }
        }
      );

      return result;

    } catch (err) {
      // All retries exhausted or non-retryable error
      if (progress) progress.onFileFailed(wireKey, err);
      failedFiles.push({
        path: wireKey,
        error: err.message,
        attempts: attemptCount
      });
      throw err;
    }
  };
}

/**
 * Build a report object for writeFailureReport.
 * @param {Array} fileList - All files
 * @param {Array} succeeded - Successful results
 * @param {Array} failedFiles - Failed file records
 * @returns {object}
 */
function buildReport(fileList, succeeded, failedFiles) {
  return {
    totalFiles: fileList.length,
    succeeded: succeeded.length,
    failures: failedFiles
  };
}

module.exports = { runSendSession };
