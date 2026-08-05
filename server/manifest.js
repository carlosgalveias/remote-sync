'use strict';

// THREAD SAFETY: This module relies on Node.js single-threaded event loop.
// All load/modify/save operations use synchronous I/O, ensuring atomicity
// within a single socket.on() handler. Do NOT convert to async without adding a mutex.

const fs = require('fs');
const path = require('path');
const { CHUNK_SIZE } = require('../common/protocol');

/**
 * @typedef {Object} ManifestFileEntry
 * @property {number} expectedSize - Total expected file size
 * @property {string} [expectedChecksum] - Expected full-file MD5 (if checksum enabled)
 * @property {number} bytesWritten - Bytes successfully written to disk
 * @property {string} lastModified - ISO 8601 timestamp of last activity
 * @property {'partial'|'complete'} status - Transfer status
 */

/**
 * @typedef {Object} Manifest
 * @property {Object<string, ManifestFileEntry>} files - Keyed by POSIX wire key
 */

const MANIFEST_DIR = '.remote-sync';
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_TMP = '.manifest.json.tmp';

/**
 * In-memory manifest cache per outputDir.
 * Avoids repeated disk I/O for every file operation.
 * @type {Map<string, Manifest>}
 */
const manifestCache = new Map();

/** Counter for registerPartial calls per outputDir (flush every N calls) */
const partialCounter = new Map();
const PARTIAL_FLUSH_INTERVAL = 10;

/**
 * Get the manifest directory path.
 * @param {string} outputDir - Base output directory
 * @returns {string}
 */
function getManifestDir(outputDir) {
  return path.join(outputDir, MANIFEST_DIR);
}

/**
 * Get the manifest file path.
 * @param {string} outputDir - Base output directory
 * @returns {string}
 */
function getManifestPath(outputDir) {
  return path.join(outputDir, MANIFEST_DIR, MANIFEST_FILE);
}

/**
 * Get the temporary manifest file path.
 * @param {string} outputDir - Base output directory
 * @returns {string}
 */
function getTmpManifestPath(outputDir) {
  return path.join(outputDir, MANIFEST_DIR, MANIFEST_TMP);
}

/**
 * Load the manifest from disk (or cache). Returns empty manifest if file doesn't exist or is corrupt.
 * Handles corruption gracefully: invalid JSON → treat as empty (fresh start).
 * Uses in-memory cache to avoid repeated disk I/O.
 *
 * @param {string} outputDir - Base output directory
 * @returns {Manifest}
 */
function loadManifest(outputDir) {
  const resolvedDir = path.resolve(outputDir);

  // Return cached version if available
  if (manifestCache.has(resolvedDir)) {
    return manifestCache.get(resolvedDir);
  }

  const manifestPath = getManifestPath(outputDir);
  const tmpPath = getTmpManifestPath(outputDir);

  // If tmp exists but manifest doesn't, a previous write crashed mid-way — discard tmp
  if (!fs.existsSync(manifestPath) && fs.existsSync(tmpPath)) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
  }

  let manifest;
  if (!fs.existsSync(manifestPath)) {
    manifest = { files: {} };
  } else {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      // Basic validation: ensure files object exists
      if (!parsed || typeof parsed.files !== 'object') {
        manifest = { files: {} };
      } else {
        manifest = parsed;
      }
    } catch (_) {
      // Corruption (invalid JSON) → start fresh
      manifest = { files: {} };
    }
  }

  manifestCache.set(resolvedDir, manifest);
  return manifest;
}

/**
 * Save manifest atomically: write to .tmp, fsync, rename.
 * Also updates the in-memory cache.
 *
 * @param {string} outputDir - Base output directory
 * @param {Manifest} manifest - Manifest data to persist
 */
function saveManifest(outputDir, manifest) {
  const resolvedDir = path.resolve(outputDir);
  const manifestDir = getManifestDir(outputDir);
  const manifestPath = getManifestPath(outputDir);
  const tmpPath = getTmpManifestPath(outputDir);

  // Update cache
  manifestCache.set(resolvedDir, manifest);

  // Ensure .remote-sync directory exists
  fs.mkdirSync(manifestDir, { recursive: true });

  // Atomic write: tmp → fsync → rename
  const fd = fs.openSync(tmpPath, 'w');
  try {
    const data = JSON.stringify(manifest, null, 2);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, manifestPath);
}

/**
 * Update a single file entry in the manifest (read-modify-write, atomic).
 *
 * @param {string} outputDir - Base output directory
 * @param {string} wireKey - POSIX relative file path
 * @param {Partial<ManifestFileEntry>} update - Fields to update/merge
 */
function updateFileEntry(outputDir, wireKey, update) {
  const manifest = loadManifest(outputDir);
  const existing = manifest.files[wireKey] || {};
  manifest.files[wireKey] = { ...existing, ...update, lastModified: new Date().toISOString() };
  saveManifest(outputDir, manifest);
}

/**
 * Mark a file as complete in the manifest.
 *
 * @param {string} outputDir - Base output directory
 * @param {string} wireKey - POSIX relative file path
 * @param {number} totalBytes - Total file size
 * @param {string|null} checksum - MD5 checksum (null if checksums disabled)
 */
function markComplete(outputDir, wireKey, totalBytes, checksum) {
  const entry = {
    expectedSize: totalBytes,
    bytesWritten: totalBytes,
    status: 'complete',
    lastModified: new Date().toISOString()
  };
  if (checksum) {
    entry.expectedChecksum = checksum;
  }
  const manifest = loadManifest(outputDir);
  manifest.files[wireKey] = entry;
  // Always flush to disk on completion (durability guarantee)
  saveManifest(outputDir, manifest);
}

/**
 * Register a file-start: create or update partial entry in manifest.
 * Flushes to disk every PARTIAL_FLUSH_INTERVAL calls to reduce I/O.
 *
 * @param {string} outputDir - Base output directory
 * @param {string} wireKey - POSIX relative file path
 * @param {number} expectedSize - Expected total file size
 * @param {string|null} expectedChecksum - Expected checksum (if provided by sender)
 * @param {number} bytesWritten - Current bytes written (0 for fresh, >0 for resume)
 */
function registerPartial(outputDir, wireKey, expectedSize, expectedChecksum, bytesWritten) {
  const entry = {
    expectedSize,
    bytesWritten,
    status: 'partial',
    lastModified: new Date().toISOString()
  };
  if (expectedChecksum) {
    entry.expectedChecksum = expectedChecksum;
  }
  const manifest = loadManifest(outputDir);
  manifest.files[wireKey] = entry;

  // Flush to disk periodically (every N registerPartial calls)
  const resolvedDir = path.resolve(outputDir);
  const count = (partialCounter.get(resolvedDir) || 0) + 1;
  partialCounter.set(resolvedDir, count);
  if (count >= PARTIAL_FLUSH_INTERVAL) {
    partialCounter.set(resolvedDir, 0);
    saveManifest(outputDir, manifest);
  }
}

/**
 * Flush any cached manifest data to disk. Call on disconnect or shutdown.
 *
 * @param {string} outputDir - Base output directory
 */
function flushManifest(outputDir) {
  const resolvedDir = path.resolve(outputDir);
  const cached = manifestCache.get(resolvedDir);
  if (cached) {
    saveManifest(outputDir, cached);
    partialCounter.set(resolvedDir, 0);
  }
}

/**
 * Determine the resume offset for a file based on manifest state and filesystem.
 *
 * Decision logic:
 * - If resume disabled (resume === false): always return offset 0 (overwrite)
 * - If file is "complete" in manifest with matching size (and checksum if provided):
 *   return offset === expectedSize (skip signal)
 * - If .part file exists with recorded partial bytes: return the .part file's actual size
 *   (use filesystem as ground truth, not just manifest)
 * - Otherwise: return 0 (start fresh)
 *
 * @param {string} outputDir - Base output directory
 * @param {string} wireKey - POSIX relative file path
 * @param {number} expectedSize - File size the sender declares
 * @param {string|null} expectedChecksum - Checksum the sender declares (null if disabled)
 * @param {boolean} resume - Whether resume is enabled for this transfer
 * @returns {number} - Byte offset (0 = fresh, size = skip, between = resume from offset)
 */
function determineOffset(outputDir, wireKey, expectedSize, expectedChecksum, resume) {
  // --no-resume: always start from 0
  if (!resume) {
    return 0;
  }

  const manifest = loadManifest(outputDir);
  const entry = manifest.files[wireKey];
  const { fromWireKey } = require('../common/files');

  // Check if file already complete
  if (entry && entry.status === 'complete') {
    // Size must match
    if (entry.expectedSize === expectedSize) {
      // If checksums enabled and both have values, compare them
      if (expectedChecksum && entry.expectedChecksum) {
        if (entry.expectedChecksum === expectedChecksum) {
          // Verify the final file actually exists on disk
          try {
            const finalPath = fromWireKey(outputDir, wireKey);
            const stat = fs.statSync(finalPath);
            if (stat.size === expectedSize) {
              return expectedSize; // Skip — file is complete and verified
            }
          } catch (_) {
            // File doesn't exist on disk — need to retransfer
            return 0;
          }
        }
        // Checksum mismatch — retransfer
        return 0;
      }

      // No checksum comparison — use size only
      try {
        const finalPath = fromWireKey(outputDir, wireKey);
        const stat = fs.statSync(finalPath);
        if (stat.size === expectedSize) {
          return expectedSize; // Skip — size matches
        }
      } catch (_) {
        return 0;
      }
    }
    // Size mismatch — retransfer
    return 0;
  }

  // Check for .part file (partial transfer)
  if (entry && entry.status === 'partial' && entry.expectedSize === expectedSize) {
    try {
      const finalPath = fromWireKey(outputDir, wireKey);
      const partPath = finalPath + '.part';
      const stat = fs.statSync(partPath);
      // Use the actual .part file size as the ground truth
      const partSize = stat.size;
      if (partSize > 0 && partSize < expectedSize) {
        // Chunk-align: round down to nearest CHUNK_SIZE boundary.
        // The last chunk may have been partially written before a crash,
        // so we discard any incomplete trailing chunk for data integrity.
        const alignedOffset = Math.floor(partSize / CHUNK_SIZE) * CHUNK_SIZE;
        return alignedOffset > 0 ? alignedOffset : 0;
      }
      if (partSize >= expectedSize) {
        // Part file is >= expected — something is wrong, start fresh
        return 0;
      }
    } catch (_) {
      // .part file doesn't exist — start fresh
      return 0;
    }
  }

  // Also check if .part file exists without manifest entry (edge case: manifest was lost)
  // In this case we don't trust it — start fresh (reconcile would have cleaned it)
  return 0;
}

/**
 * Reconcile manifest with filesystem on receiver startup.
 * Removes stale .part files that don't have corresponding manifest entries.
 *
 * @param {string} outputDir - Base output directory
 */
function reconcile(outputDir) {
  const manifest = loadManifest(outputDir);
  const { fromWireKey } = require('../common/files');

  // Build set of expected .part paths from manifest entries with status 'partial'
  const expectedParts = new Set();
  for (const [wireKey, entry] of Object.entries(manifest.files)) {
    if (entry.status === 'partial') {
      try {
        const finalPath = fromWireKey(outputDir, wireKey);
        expectedParts.add(finalPath + '.part');
      } catch (_) {
        // Invalid wire key in manifest — skip
      }
    }
  }

  // Scan filesystem recursively for .part files
  const partFiles = findPartFiles(outputDir);

  // Delete .part files that are not in the manifest
  for (const partFile of partFiles) {
    if (!expectedParts.has(partFile)) {
      try {
        fs.unlinkSync(partFile);
        console.log(`[manifest] Cleaned stale .part file: ${partFile}`);
      } catch (_) {
        // ignore cleanup errors
      }
    }
  }
}

/**
 * Recursively find all .part files under outputDir, excluding .remote-sync directory.
 *
 * @param {string} dir - Directory to scan
 * @returns {string[]} - Array of absolute paths to .part files
 */
function findPartFiles(dir) {
  const results = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir);
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      // Skip the .remote-sync metadata directory
      if (entry === MANIFEST_DIR && currentDir === dir) continue;

      const fullPath = path.join(currentDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile() && entry.endsWith('.part')) {
          results.push(fullPath);
        }
      } catch (_) {
        // Skip inaccessible entries
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Remove a file entry from the manifest.
 *
 * @param {string} outputDir - Base output directory
 * @param {string} wireKey - POSIX relative file path
 */
function removeEntry(outputDir, wireKey) {
  const manifest = loadManifest(outputDir);
  delete manifest.files[wireKey];
  saveManifest(outputDir, manifest);
}

module.exports = {
  loadManifest,
  saveManifest,
  updateFileEntry,
  markComplete,
  registerPartial,
  determineOffset,
  reconcile,
  removeEntry,
  flushManifest,
  getManifestDir,
  getManifestPath
};
