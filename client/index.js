'use strict';

const io = require('socket.io-client');
const ss = require('socket.io-stream');
const progress = require('progress-stream');
const fs = require('fs');
const { listFilesFromFolder } = require('../common/files');
const { computeFileChecksum, createHashStream } = require('../common/checksum');
const { createCompressStream } = require('../common/compression');
const { ConcurrencyPool } = require('../common/concurrency');

/**
 * Connect to the remote-sync server via WebSocket.
 * @param {string} server - Hostname or IP
 * @returns {SocketIOClient.Socket}
 */
function connect(server) {
  return io.connect(`ws://${server}:8000`);
}

/**
 * Emit session-init and wait for session-ack from the server.
 * @param {SocketIOClient.Socket} socket
 * @param {object} sessionOpts - { compress, checksum }
 * @returns {Promise<void>}
 */
function initSession(socket, sessionOpts) {
  return new Promise((resolve, reject) => {
    socket.emit('session-init', sessionOpts);
    socket.once('session-ack', () => {
      console.log('[session] Server acknowledged session settings.');
      resolve();
    });
    setTimeout(() => reject(new Error('session-ack timeout')), 15000);
  });
}

/**
 * Execute the resume protocol: send manifest, receive skip/transfer lists.
 * @param {SocketIOClient.Socket} socket
 * @param {Array<{file: string, type: string}>} fileList - Only type==='file' entries
 * @returns {Promise<{skip: string[], transfer: string[]}>}
 */
async function queryResume(socket, fileList) {
  console.log('[resume] Computing checksums for resume query...');
  const manifest = [];
  for (const entry of fileList) {
    const checksum = await computeFileChecksum(entry.file);
    manifest.push({ file: entry.file, checksum });
  }

  return new Promise((resolve, reject) => {
    socket.emit('resume-query', manifest);
    socket.once('resume-response', (response) => {
      resolve(response);
    });
    setTimeout(() => reject(new Error('resume-response timeout')), 30000);
  });
}

/**
 * Send a single file with pre-computed checksum, compression, and retry logic.
 * @param {object} fileEntry - { file: string }
 * @param {SocketIOClient.Socket} socket
 * @param {object} opts - Processed options
 * @param {string|null} precomputedChecksum - MD5 hex if checksum enabled
 * @returns {Promise<void>}
 */
function sendFileWithRetry(fileEntry, socket, opts, precomputedChecksum) {
  let attempts = 0;
  const maxAttempts = opts.retries;

  const doSend = () => {
    attempts++;
    return new Promise((resolve, reject) => {
      const filePath = fileEntry.file;
      const fileSize = fs.statSync(filePath).size;

      console.log(`[send] Starting: ${filePath} (attempt ${attempts}/${maxAttempts})`);

      const stream = ss.createStream();

      const progressStream = progress({
        length: fileSize,
        time: 500 /* ms */
      });

      progressStream.on('progress', (p) => {
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        process.stdout.write(
          `[progress] ${filePath} — ${Math.round(p.percentage)}% | ETA: ${p.eta}s`
        );
      });

      const readStream = fs.createReadStream(filePath);

      // Build pipeline based on options:
      // With compression + checksum: ReadStream → ProgressStream → HashStream → BrotliCompress → ss stream
      // With checksum only:          ReadStream → ProgressStream → HashStream → ss stream
      // With compression only:       ReadStream → ProgressStream → BrotliCompress → ss stream
      // Neither:                      ReadStream → ProgressStream → ss stream
      let pipeline = readStream.pipe(progressStream);

      if (opts.checksum) {
        const hashStream = createHashStream();
        pipeline = pipeline.pipe(hashStream);
      }

      if (opts.compress) {
        const compressStream = createCompressStream();
        pipeline = pipeline.pipe(compressStream);
      }

      // Build metadata
      const metadata = {
        file: filePath,
        compressed: opts.compress
      };

      if (opts.checksum && precomputedChecksum) {
        metadata.checksum = precomputedChecksum;
      }

      // Emit the file event — socket.io-stream handles data flow
      ss(socket).emit('file', stream, metadata);

      // Pipe the assembled pipeline into the socket.io-stream
      pipeline.pipe(stream);

      stream.on('error', (err) => {
        process.stdout.write('\n');
        console.error(`[error] Error sending file: ${filePath}`, err);
        reject(err);
      });

      if (opts.checksum) {
        // Wait for file-ack from server, filtered by file path
        const onAck = (ack) => {
          if (ack.file === filePath) {
            socket.removeListener('file-ack', onAck);
            process.stdout.write('\n');
            if (ack.status === 'ok') {
              console.log(`[done] File transferred and verified: ${filePath}`);
              resolve();
            } else {
              console.warn(`[mismatch] Checksum mismatch for: ${filePath}`);
              reject(new Error('CHECKSUM_MISMATCH'));
            }
          }
        };
        socket.on('file-ack', onAck);
      } else {
        // No ack needed, resolve when the piped data finishes
        pipeline.on('end', () => {
          process.stdout.write('\n');
          console.log(`[done] File transferred: ${filePath}`);
          resolve();
        });
      }
    });
  };

  const attempt = () => {
    return doSend().catch((err) => {
      if (err.message === 'CHECKSUM_MISMATCH' && attempts < maxAttempts) {
        console.log(`[retry] Retrying ${fileEntry.file} (attempt ${attempts + 1}/${maxAttempts})`);
        return attempt();
      }
      throw err;
    });
  };

  return attempt();
}

/**
 * Process the file transfer request.
 * @param {string} server - Server hostname or IP
 * @param {string} folder - Folder path to send
 * @param {object} [options] - Transfer options
 */
async function processRequest(server, folder, options = {}) {
  const opts = {
    concurrency: options.concurrency || 5,
    compress: options.compress || false,
    checksum: options.checksum !== undefined ? options.checksum : true,
    retries: options.retries || 3,
    resume: options.resume !== undefined ? options.resume : true
  };

  console.log('[config] Options:', JSON.stringify(opts, null, 2));

  const socket = connect(server);

  socket.on('connect', async () => {
    console.log(`[connected] Connected to server: ${server}`);

    try {
      // 1. Session initialization
      await initSession(socket, { compress: opts.compress, checksum: opts.checksum });

      // 2. Build file list (only actual files)
      const allEntries = listFilesFromFolder(folder);
      const fileList = allEntries.filter((entry) => entry.type === 'file');
      console.log(`[files] Found ${fileList.length} file(s) to process.`);

      let filesToSend = fileList;
      const checksumMap = new Map();

      // 3. Resume protocol
      if (opts.resume && opts.checksum) {
        const resumeResult = await queryResume(socket, fileList);
        const skipSet = new Set(resumeResult.skip || []);
        const transferSet = new Set(resumeResult.transfer || []);

        filesToSend = fileList.filter((entry) => transferSet.has(entry.file));
        console.log(`[resume] Skipping ${skipSet.size} file(s) already on server.`);
        console.log(`[resume] Transferring ${filesToSend.length} file(s).`);
      }

      // 4. Pre-compute checksums if needed
      if (opts.checksum) {
        console.log('[checksum] Computing file checksums...');
        for (const entry of filesToSend) {
          const checksum = await computeFileChecksum(entry.file);
          checksumMap.set(entry.file, checksum);
        }
      }

      // 5. Parallel file sending
      if (filesToSend.length === 0) {
        console.log('[done] No files to transfer. All up to date!');
        process.exit(0);
        return;
      }

      const pool = new ConcurrencyPool(opts.concurrency);
      const tasks = filesToSend.map((entry) => {
        return () => {
          const checksum = checksumMap.get(entry.file) || null;
          return sendFileWithRetry(entry, socket, opts, checksum);
        };
      });

      await pool.runAll(tasks);

      console.log('\n[complete] All files transferred!');
      process.exit(0);
    } catch (err) {
      console.error('[fatal] Transfer failed:', err.message);
      process.exit(1);
    }
  });

  socket.on('connect_error', (err) => {
    console.error(`[error] Connection failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = processRequest;
