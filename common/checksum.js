'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { Transform } = require('stream');

/**
 * Compute MD5 checksum of a file given its path.
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<string>} - Hex string of the MD5 hash
 */
function computeFileChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Creates a Transform stream that computes MD5 hash as data passes through.
 * Data passes through unchanged. Call getHash() after stream ends to get the checksum.
 * @returns {Transform & { getHash: () => string }}
 */
function createHashStream() {
  const hash = crypto.createHash('md5');
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      this.push(chunk);
      callback();
    }
  });
  transform.getHash = () => hash.digest('hex');
  return transform;
}

module.exports = { computeFileChecksum, createHashStream };
