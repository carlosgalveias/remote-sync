#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const path = require('path');
const pkg = require('./package.json');
const { DEFAULT_PORT } = require('./common/protocol');

program.version(pkg.version);

/**
 * Validate a port number string.
 * @param {string} value
 * @returns {number}
 */
function validatePort(value) {
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`[error] Invalid port: ${value}. Must be 1-65535.`);
    process.exit(1);
  }
  return port;
}

/**
 * Validate a positive integer (>= 0).
 * @param {string} value
 * @param {string} name
 * @returns {number}
 */
function validatePositiveInt(value, name) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) {
    console.error(`[error] Invalid ${name}: ${value}. Must be a non-negative integer.`);
    process.exit(1);
  }
  return n;
}

/**
 * Validate concurrency (1-100).
 * @param {string} value
 * @returns {number}
 */
function validateConcurrency(value) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1 || n > 100) {
    console.error(`[error] Invalid concurrency: ${value}. Must be 1-100.`);
    process.exit(1);
  }
  return n;
}

// --- Receive command (start server) ---
program
  .command('receive')
  .description('start a server to receive data')
  .option('-p, --port <number>', 'port to listen on', String(DEFAULT_PORT))
  .option('-o, --output <dir>', 'output directory', process.cwd())
  .option('-v, --verbose', 'verbose output')
  .option('-q, --quiet', 'quiet output (errors only)')
  .option('--log-file <path>', 'write all output to a log file')
  .action((options) => {
    const port = validatePort(options.port);

    if (options.verbose && options.quiet) {
      console.error('[error] --verbose and --quiet are mutually exclusive.');
      process.exit(1);
    }

    const { startReceiver } = require('./server/index');
    startReceiver({
      port,
      outputDir: path.resolve(options.output),
      verbose: options.verbose || false,
      quiet: options.quiet || false,
      logFile: options.logFile || null
    }).catch((err) => {
      console.error('[fatal] Server failed to start:', err.message);
      process.exit(1);
    });
  });

// --- Send command (client) ---
program
  .command('send')
  .description('copy folder recursively to receiver')
  .option('-a, --address <ip>', 'ip address of the receiver', '127.0.0.1')
  .option('-p, --port <number>', 'port of the receiver', String(DEFAULT_PORT))
  .option('-f, --folder <folder>', 'folder to copy', process.cwd())
  .option('-c, --concurrency <number>', 'number of parallel file transfers', '5')
  .option('-z, --compress', 'enable Brotli compression')
  .option('--no-checksum', 'disable MD5 checksum verification')
  .option('-r, --retries <number>', 'max retries per file on checksum mismatch', '3')
  .option('--no-resume', 'disable resume capability')
  .option('--timeout <ms>', 'per-chunk ack timeout in milliseconds', '30000')
  .option('--global-timeout <ms>', 'total transfer timeout (0 = no limit)', '0')
  .option('--dry-run', 'list files that would be transferred, then exit')
  .option('-v, --verbose', 'show per-file events')
  .option('-q, --quiet', 'suppress progress bar, only show final summary + errors')
  .option('--log-file <path>', 'write detailed transfer log to file')
  .action(async (options) => {
    // Validate mutually exclusive flags
    if (options.verbose && options.quiet) {
      console.error('[error] --verbose and --quiet are mutually exclusive.');
      process.exit(1);
    }

    const port = validatePort(options.port);
    const concurrency = validateConcurrency(options.concurrency);
    const timeout = validatePositiveInt(options.timeout, 'timeout');
    const globalTimeout = validatePositiveInt(options.globalTimeout, 'global-timeout');
    const retries = validatePositiveInt(options.retries, 'retries');

    const { runSendSession } = require('./client/index');

    try {
      const result = await runSendSession({
        address: options.address,
        port,
        folder: path.resolve(options.folder),
        options: {
          concurrency,
          compress: options.compress || false,
          checksum: options.checksum,
          retries,
          resume: options.resume,
          timeout,
          globalTimeout,
          dryRun: options.dryRun || false,
          verbose: options.verbose || false,
          quiet: options.quiet || false,
          logFile: options.logFile || null
        }
      });

      process.exit(result.exitCode || (result.failed.length > 0 ? 1 : 0));

    } catch (err) {
      console.error('[fatal] Transfer failed:', err.message);
      process.exit(err.exitCode || 2);
    }
  });

program.parse(process.argv);
