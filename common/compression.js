'use strict';

const zlib = require('zlib');

/**
 * Default Brotli compression options - optimized for speed on LAN transfers.
 * Quality 3 gives ~2x compression on text with minimal CPU overhead.
 */
const DEFAULT_BROTLI_OPTIONS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 3
  }
};

/**
 * Creates a Brotli compression transform stream.
 * @param {object} [options] - Brotli options (defaults to quality 3)
 * @returns {zlib.BrotliCompress}
 */
function createCompressStream(options = DEFAULT_BROTLI_OPTIONS) {
  return zlib.createBrotliCompress(options);
}

/**
 * Creates a Brotli decompression transform stream.
 * @returns {zlib.BrotliDecompress}
 */
function createDecompressStream() {
  return zlib.createBrotliDecompress();
}

module.exports = { createCompressStream, createDecompressStream, DEFAULT_BROTLI_OPTIONS };
