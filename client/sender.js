'use strict';

const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { CHUNK_SIZE, EVENTS } = require('../common/protocol');
const { emitWithAck } = require('./connection');
const { DEFAULT_BROTLI_OPTIONS } = require('../common/compression');

const brotliCompress = promisify(zlib.brotliCompress);

/**
 * Fast-forward the hash through already-sent bytes (local disk read only, no network).
 * Reads from byte 0 to `offset` in chunks, updating the hash incrementally.
 * This ensures the full-file MD5 is correct even when resuming from a byte offset.
 *
 * @param {fs.promises.FileHandle} fileHandle - Open file handle
 * @param {number} offset - Byte offset to hash up to
 * @param {crypto.Hash} hash - Incremental hash instance to update
 * @param {number} chunkSize - Read buffer size
 * @returns {Promise<void>}
 */
async function hashFastForward(fileHandle, offset, hash, chunkSize) {
  const buffer = Buffer.allocUnsafe(chunkSize);
  let pos = 0;
  while (pos < offset) {
    const toRead = Math.min(chunkSize, offset - pos);
    const { bytesRead } = await fileHandle.read(buffer, 0, toRead, pos);
    if (bytesRead === 0) break; // unexpected EOF
    hash.update(buffer.subarray(0, bytesRead));
    pos += bytesRead;
  }
}

/**
 * Send a single file using the chunked protocol with async I/O.
 * Reads file asynchronously in chunks, compresses per-chunk if enabled,
 * computes MD5 incrementally, and waits for ack after each chunk (backpressure).
 *
 * Phase 5: Supports resume via offset from file-start-ack:
 * - offset === 0: transfer from beginning
 * - offset === size: file is complete on receiver, skip it
 * - 0 < offset < size: resume from that byte (hash prefix first if checksum enabled)
 *
 * Throws on any error so that ConcurrencyPool.runAllSettled can catch it
 * and populate the `failed` array correctly.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {object} fileInfo - { absolutePath, relativePath (wireKey), size, mtime }
 * @param {object} options - { compress, checksum, chunkSize, resume }
 * @param {object} [callbacks]
 * @param {function} [callbacks.onChunkSent] - (fileKey, chunkIndex, totalChunks, bytesSent) => void
 * @param {function} [callbacks.onFileComplete] - (fileKey, status) => void
 * @param {function} [callbacks.onFileSkipped] - (fileKey) => void
 * @returns {Promise<{status: string, bytesSent: number}>}
 * @throws {Error} On any transfer failure (rejected start, chunk error, checksum mismatch)
 */
async function sendFile(socket, fileInfo, options, callbacks = {}) {
  const chunkSize = options.chunkSize || CHUNK_SIZE;
  const compress = !!options.compress;
  const checksum = !!options.checksum;
  const resume = options.resume !== false;
  const wireKey = fileInfo.relativePath;

  /** @type {fs.promises.FileHandle|null} */
  let fileHandle = null;

  try {
    // 1. Emit file-start, get ack with resume offset
    const startAck = await emitWithAck(socket, EVENTS.FILE_START, {
      fileKey: wireKey,
      size: fileInfo.size,
      mtime: fileInfo.mtime,
      compressed: compress,
      checksum: checksum,
      resume: resume
    });

    if (!startAck || !startAck.ok) {
      const err = new Error(startAck ? startAck.error || 'file-start rejected' : 'No ack received');
      if (callbacks.onFileComplete) callbacks.onFileComplete(wireKey, 'error');
      throw err;
    }

    // Phase 5: offset from receiver determines resume behavior
    const offset = startAck.offset || 0;

    // Skip: receiver already has the complete file
    // Guard: `&& fileInfo.size > 0` prevents skipping empty files (size===0) when offset===0,
    // since empty files still need a file-end event to be committed on the receiver side.
    if (offset >= fileInfo.size && fileInfo.size > 0) {
      if (callbacks.onFileSkipped) callbacks.onFileSkipped(wireKey);
      if (callbacks.onFileComplete) callbacks.onFileComplete(wireKey, 'skipped');
      return { status: 'skipped', bytesSent: 0 };
    }

    // Handle empty files (size === 0)
    if (fileInfo.size === 0) {
      const md5 = checksum ? crypto.createHash('md5').digest('hex') : null;
      const endAck = await emitWithAck(socket, EVENTS.FILE_END, {
        fileKey: wireKey,
        md5: md5,
        totalChunks: 0,
        totalBytes: 0
      });

      const status = endAck && endAck.ok ? (endAck.status || 'verified') : 'error';
      if (callbacks.onFileComplete) callbacks.onFileComplete(wireKey, status);
      if (!endAck || !endAck.ok) {
        throw new Error(endAck ? endAck.status || 'verification failed' : 'No ack received');
      }
      return { status, bytesSent: 0 };
    }

    // 2. Open file for async reading
    fileHandle = await fs.promises.open(fileInfo.absolutePath, 'r');
    const hash = checksum ? crypto.createHash('md5') : null;

    // Phase 5: If resuming from offset > 0 and checksum enabled,
    // fast-forward the hash through already-sent bytes (local read only)
    if (offset > 0 && hash) {
      await hashFastForward(fileHandle, offset, hash, chunkSize);
    }

    // Calculate chunks from the offset onward
    const totalChunks = Math.ceil(fileInfo.size / chunkSize) || 1;
    let chunkIndex = Math.floor(offset / chunkSize);
    let bytesRead = offset;
    let bytesSent = 0; // Track only bytes actually sent over the wire

    // 3. Read and send chunks asynchronously from offset
    const buffer = Buffer.allocUnsafe(chunkSize);

    while (bytesRead < fileInfo.size) {
      const readSize = Math.min(chunkSize, fileInfo.size - bytesRead);
      const { bytesRead: n } = await fileHandle.read(buffer, 0, readSize, bytesRead);
      const chunk = buffer.subarray(0, n);

      // Update incremental hash with raw (uncompressed) data
      if (hash) {
        hash.update(chunk);
      }

      // Compress chunk independently if enabled (async)
      const payload = compress
        ? await brotliCompress(chunk, DEFAULT_BROTLI_OPTIONS)
        : chunk;

      // Emit chunk and wait for ack (backpressure)
      const chunkAck = await emitWithAck(socket, EVENTS.FILE_CHUNK, {
        fileKey: wireKey,
        index: chunkIndex,
        data: payload
      });

      if (!chunkAck || !chunkAck.ok) {
        await fileHandle.close();
        fileHandle = null;
        const err = new Error(chunkAck ? chunkAck.error || 'chunk rejected' : 'No chunk ack');
        if (callbacks.onFileComplete) callbacks.onFileComplete(wireKey, 'error');
        throw err;
      }

      bytesRead += n;
      bytesSent += n;

      // Report progress: only bytes actually sent (not the hash fast-forward)
      if (callbacks.onChunkSent) {
        callbacks.onChunkSent(wireKey, chunkIndex, totalChunks, bytesSent);
      }

      chunkIndex++;
    }

    // 4. Close file handle
    await fileHandle.close();
    fileHandle = null;

    // 5. Emit file-end with full-file checksum (covers bytes 0..end)
    const md5 = hash ? hash.digest('hex') : null;
    const endAck = await emitWithAck(socket, EVENTS.FILE_END, {
      fileKey: wireKey,
      md5: md5,
      totalChunks: chunkIndex,
      totalBytes: fileInfo.size
    });

    const status = endAck && endAck.ok ? (endAck.status || 'verified') : 'checksum_mismatch';
    if (callbacks.onFileComplete) callbacks.onFileComplete(wireKey, status);

    if (!endAck || !endAck.ok) {
      throw new Error(endAck ? endAck.status || 'verification failed' : 'No ack received');
    }

    return { status, bytesSent };

  } catch (err) {
    // Ensure file handle is cleaned up on any error
    if (fileHandle !== null) {
      try { await fileHandle.close(); } catch (_) { /* ignore close error */ }
    }
    if (callbacks.onFileComplete) callbacks.onFileComplete(wireKey, 'error');
    throw err;
  }
}

module.exports = { sendFile, hashFastForward };
