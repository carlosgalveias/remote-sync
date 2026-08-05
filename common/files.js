'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Recursively list all files in a folder.
 * Returns objects with both absolute path, POSIX-relative path, size, and mtime.
 *
 * @param {string} folder - Root folder to scan
 * @returns {Array<{relativePath: string, absolutePath: string, size: number, mtime: number}>}
 */
function listFiles(folder) {
  const rootFolder = path.resolve(folder || './');
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      console.warn(`[files] Could not read directory: ${dir} (${err.message})`);
      return;
    }

    for (const entry of entries) {
      if (entry === '.remote-sync') continue; // skip metadata directory at any nesting level

      const absolutePath = path.join(dir, entry);
      try {
        const stat = fs.statSync(absolutePath);
        if (stat.isDirectory()) {
          walk(absolutePath);
        } else if (stat.isFile()) {
          const relativePath = toWireKey(rootFolder, absolutePath);
          results.push({
            relativePath,
            absolutePath,
            size: stat.size,
            mtime: stat.mtimeMs
          });
        }
      } catch (err) {
        console.error(`[files] Error accessing ${entry}: ${err.message}`);
      }
    }
  }

  walk(rootFolder);
  return results;
}

/**
 * Convert absolute path to POSIX-relative wire key.
 * Always returns forward-slash separated path without leading './' or '/'.
 *
 * @param {string} rootFolder - The folder being sent (will be resolved)
 * @param {string} absolutePath - File's absolute path
 * @returns {string} - POSIX relative path (e.g., 'src/utils/helper.js')
 * @throws {Error} - If path is unsafe (contains '..', starts with '/')
 */
function toWireKey(rootFolder, absolutePath) {
  const resolvedRoot = path.resolve(rootFolder);
  const resolvedFile = path.resolve(absolutePath);
  const relative = path.relative(resolvedRoot, resolvedFile);

  // Convert to POSIX format (forward slashes)
  const wireKey = relative.split(path.sep).join('/');

  // Validate: must not start with '/' or contain '..'
  if (wireKey.startsWith('/')) {
    throw new Error(`Unsafe path (absolute): ${wireKey}`);
  }
  if (wireKey.includes('..')) {
    throw new Error(`Unsafe path (traversal): ${wireKey}`);
  }

  return wireKey;
}

/**
 * Convert wire key to safe local path, validated against output directory.
 * Rejects path traversal attacks and backslash injection.
 *
 * @param {string} outputDir - Server's output directory
 * @param {string} wireKey - POSIX relative path from wire
 * @returns {string} - Absolute local path
 * @throws {Error} - If path escapes outputDir or contains unsafe characters
 */
function fromWireKey(outputDir, wireKey) {
  // Reject obviously malicious keys
  if (wireKey.includes('..')) {
    throw new Error(`Rejected unsafe fileKey (traversal): ${wireKey}`);
  }
  if (wireKey.startsWith('/')) {
    throw new Error(`Rejected unsafe fileKey (absolute): ${wireKey}`);
  }
  if (wireKey.includes('\\')) {
    throw new Error(`Rejected unsafe fileKey (backslash): ${wireKey}`);
  }

  // Join and resolve
  const joined = path.join(outputDir, wireKey);
  const resolved = path.resolve(joined);

  // Final check: must be within outputDir
  const resolvedOutput = path.resolve(outputDir);
  if (resolved !== resolvedOutput && !resolved.startsWith(resolvedOutput + path.sep)) {
    throw new Error(`Path escape attempt: ${wireKey} resolves to ${resolved}`);
  }

  return resolved;
}

/**
 * Legacy function — kept for backward compatibility with old client/index.js.
 * Returns entries in the old format: { file: absolutePath, type: 'file'|'folder' }
 *
 * @param {string} folder - Folder to scan
 * @param {Array} [foundFiles] - Accumulator (internal)
 * @returns {Array<{file: string, type: string}>}
 */
function listFilesFromFolder(folder, foundFiles) {
  if (!folder) { folder = './'; }
  if (!foundFiles) { foundFiles = []; }

  let files;
  try {
    files = fs.readdirSync(path.resolve(folder));
  } catch (_e) {
    console.warn('Could not read folder', folder);
    return foundFiles;
  }

  for (const file of files) {
    try {
      const filePath = path.join(folder, file);
      const fullPath = path.resolve(filePath);
      if (fs.statSync(filePath).isDirectory()) {
        foundFiles.push({ file: fullPath, type: 'folder' });
        foundFiles = foundFiles.concat(listFilesFromFolder(filePath));
      } else {
        foundFiles.push({ file: fullPath, type: 'file' });
      }
    } catch (err) {
      console.error(`[error] Error accessing file ${file}: ${err.message}`);
    }
  }
  return foundFiles;
}

module.exports = {
  listFiles,
  listFilesFromFolder,
  toWireKey,
  fromWireKey
};
