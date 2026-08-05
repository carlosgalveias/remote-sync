'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { EVENTS } = require('../common/protocol');
const { fromWireKey } = require('../common/files');
const {
  markComplete,
  registerPartial,
  determineOffset,
  reconcile,
  flushManifest
} = require('./manifest');

/**
 * Register file transfer handlers on a socket.
 * Manages per-file state for chunk assembly, atomic writes, and verification.
 * Phase 5: Integrates manifest-based resume — determines offset from receiver state.
 *
 * @param {import('socket.io').Socket} socket - Connected client socket
 * @param {string} outputDir - Base output directory
 * @param {object} sessionOptions - { compress, checksum, resume }
 */
function registerFileHandlers(socket, outputDir, sessionOptions) {
  // Default resume to true unless explicitly disabled
  const resumeEnabled = sessionOptions.resume !== false;

  /**
   * Active file transfers state.
   * Map<fileKey, { fd, hash, partPath, finalPath, compressed, checksum, bytesWritten, expectedSize }>
   */
  const activeFiles = new Map();

  // --- file-start handler ---
  socket.on(EVENTS.FILE_START, (payload, ack) => {
    const fileKey = payload.fileKey;

    try {
      // Validate and resolve path (throws on unsafe paths)
      const finalPath = fromWireKey(outputDir, fileKey);
      const partPath = finalPath + '.part';

      // Create directory structure
      const dir = path.dirname(finalPath);
      fs.mkdirSync(dir, { recursive: true });

      // Determine resume offset from manifest + filesystem state
      // If sender sends resume: false, or session-level resume is disabled → offset = 0
      const senderResume = payload.resume !== false && resumeEnabled;
      const expectedChecksum = payload.checksum ? (payload.expectedChecksum || null) : null;
      const offset = determineOffset(outputDir, fileKey, payload.size, expectedChecksum, senderResume);

      // If offset === size → file is already complete, signal skip
      if (offset === payload.size && payload.size > 0) {
        if (typeof ack === 'function') {
          ack({ ok: true, offset: payload.size });
        }
        console.log(`[receiver] Skipped (complete): ${fileKey}`);
        return;
      }

      // Determine open mode: append if resuming, truncate if fresh
      let fd;
      if (offset > 0) {
        // Resuming: open existing .part in read+write mode, truncate to offset
        // (in case .part has extra bytes beyond what we trust)
        fd = fs.openSync(partPath, 'r+');
        const currentSize = fs.fstatSync(fd).size;
        if (currentSize > offset) {
          fs.ftruncateSync(fd, offset);
        }
        // Seek to offset for next write (writeSync with position will handle this)
      } else {
        // Fresh start: truncate/create
        fd = fs.openSync(partPath, 'w');
      }

      // Initialize incremental hash if checksum is enabled for this file
      const useChecksum = !!payload.checksum;
      const hash = useChecksum ? crypto.createHash('md5') : null;

      // Phase 5 fix: When resuming, fast-forward the hash through already-written bytes
      // so the final digest covers bytes[0..end] (matching sender's full-file MD5).
      if (offset > 0 && hash) {
        const HASH_CHUNK = 128 * 1024;
        const partFd = fs.openSync(partPath, 'r');
        try {
          let pos = 0;
          const buf = Buffer.allocUnsafe(HASH_CHUNK);
          while (pos < offset) {
            const toRead = Math.min(HASH_CHUNK, offset - pos);
            const n = fs.readSync(partFd, buf, 0, toRead, pos);
            if (n === 0) break;
            hash.update(buf.subarray(0, n));
            pos += n;
          }
        } finally {
          fs.closeSync(partFd);
        }
      }

      activeFiles.set(fileKey, {
        fd,
        hash,
        partPath,
        finalPath,
        compressed: !!payload.compressed,
        checksum: useChecksum,
        expectedChecksum: expectedChecksum,
        bytesWritten: offset,
        expectedSize: payload.size,
        writePosition: offset
      });

      // Register partial state in manifest
      registerPartial(outputDir, fileKey, payload.size, expectedChecksum, offset);

      if (typeof ack === 'function') {
        ack({ ok: true, offset: offset });
      }

      console.log(`[receiver] Started: ${fileKey} (${payload.size} bytes, offset: ${offset})`);

    } catch (err) {
      console.error(`[receiver] file-start error for ${fileKey}: ${err.message}`);
      if (typeof ack === 'function') {
        ack({ ok: false, error: err.message });
      }
    }
  });

  // --- file-chunk handler ---
  socket.on(EVENTS.FILE_CHUNK, (payload, ack) => {
    const fileKey = payload.fileKey;
    const state = activeFiles.get(fileKey);

    if (!state) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'No active transfer for this key' });
      }
      return;
    }

    try {
      // Normalize to Buffer before any operation (Socket.IO may deliver ArrayBuffer/Uint8Array)
      const rawData = Buffer.isBuffer(payload.data) ? payload.data : Buffer.from(payload.data);

      // Decompress if needed
      const data = state.compressed
        ? zlib.brotliDecompressSync(rawData)
        : rawData;

      // Update incremental hash with decompressed data
      if (state.hash) {
        state.hash.update(data);
      }

      // Write to .part file at current position
      fs.writeSync(state.fd, data, 0, data.length, state.writePosition);
      state.bytesWritten += data.length;
      state.writePosition += data.length;

      if (typeof ack === 'function') {
        ack({ ok: true });
      }

    } catch (err) {
      console.error(`[receiver] file-chunk error for ${fileKey}: ${err.message}`);

      // Clean up on chunk error
      try {
        fs.closeSync(state.fd);
      } catch (_) { /* ignore */ }
      try {
        fs.unlinkSync(state.partPath);
      } catch (_) { /* ignore */ }
      activeFiles.delete(fileKey);

      if (typeof ack === 'function') {
        ack({ ok: false, error: err.message });
      }
    }
  });

  // --- file-end handler ---
  socket.on(EVENTS.FILE_END, (payload, ack) => {
    const fileKey = payload.fileKey;
    const state = activeFiles.get(fileKey);

    if (!state) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'No active transfer for this key' });
      }
      return;
    }

    try {
      // Verify checksum if enabled
      if (state.hash && payload.md5) {
        const receivedMd5 = state.hash.digest('hex');
        if (receivedMd5 !== payload.md5) {
          // Checksum mismatch — close fd, delete .part, report error
          fs.closeSync(state.fd);
          try {
            fs.unlinkSync(state.partPath);
          } catch (_) { /* ignore */ }
          activeFiles.delete(fileKey);

          console.error(`[receiver] Checksum mismatch for ${fileKey}: expected ${payload.md5}, got ${receivedMd5}`);

          if (typeof ack === 'function') {
            ack({ ok: false, status: 'checksum_mismatch', expected: payload.md5, received: receivedMd5 });
          }
          return;
        }
      }

      // Atomic commit: fsync + rename
      fs.fsyncSync(state.fd);
      fs.closeSync(state.fd);
      fs.renameSync(state.partPath, state.finalPath);

      activeFiles.delete(fileKey);

      // Update manifest: mark file as complete
      markComplete(outputDir, fileKey, payload.totalBytes || state.bytesWritten, payload.md5 || null);

      console.log(`[receiver] Completed: ${fileKey} (${state.bytesWritten} bytes)`);

      if (typeof ack === 'function') {
        ack({ ok: true, status: 'verified' });
      }

    } catch (err) {
      console.error(`[receiver] file-end error for ${fileKey}: ${err.message}`);

      // Clean up on error
      try {
        fs.closeSync(state.fd);
      } catch (_) { /* ignore */ }
      try {
        fs.unlinkSync(state.partPath);
      } catch (_) { /* ignore */ }
      activeFiles.delete(fileKey);

      if (typeof ack === 'function') {
        ack({ ok: false, error: err.message });
      }
    }
  });

  // --- Cleanup on disconnect ---
  socket.on('disconnect', () => {
    // Leave .part files in place for future resume
    // Update manifest with current bytesWritten for each active transfer
    for (const [fileKey, state] of activeFiles.entries()) {
      try {
        fs.fsyncSync(state.fd);
        fs.closeSync(state.fd);
      } catch (_) { /* ignore */ }

      // Persist partial progress to manifest (preserve expectedChecksum from file-start)
      try {
        registerPartial(outputDir, fileKey, state.expectedSize, state.expectedChecksum || null, state.bytesWritten);
      } catch (_) { /* ignore */ }

      console.log(`[receiver] Disconnect: left .part file for ${fileKey} (${state.bytesWritten} bytes)`);
    }
    activeFiles.clear();

    // Flush cached manifest to disk on disconnect (ensures all registerPartial updates are persisted)
    try {
      flushManifest(outputDir);
    } catch (_) { /* ignore */ }
  });
}

/**
 * Initialize receiver-side resume state on startup.
 * Reconciles manifest with filesystem (cleans stale .part files).
 *
 * @param {string} outputDir - Base output directory
 */
function initReceiverResume(outputDir) {
  reconcile(outputDir);
}

module.exports = { registerFileHandlers, initReceiverResume };
