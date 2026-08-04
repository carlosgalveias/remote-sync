'use strict';

const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const crypto = require('crypto');
const { createCompressStream, createDecompressStream, DEFAULT_BROTLI_OPTIONS } = require('../../common/compression');

/**
 * Helper: collect all chunks from a readable stream into a single Buffer.
 */
function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('createCompressStream / createDecompressStream', () => {
  it('compressed data should be different from original', async () => {
    const input = Buffer.from('Hello, this is some text to compress!');
    const compress = createCompressStream();

    const readable = Readable.from([input]);
    readable.pipe(compress);

    const compressed = await collectStream(compress);
    expect(compressed.equals(input)).toBe(false);
    expect(compressed.length).toBeGreaterThan(0);
  });

  it('decompressing compressed data should return original', async () => {
    const input = Buffer.from('Round trip test: this should survive compression and decompression intact.');
    const compress = createCompressStream();
    const decompress = createDecompressStream();

    const readable = Readable.from([input]);
    readable.pipe(compress).pipe(decompress);

    const result = await collectStream(decompress);
    expect(result.equals(input)).toBe(true);
  });

  it('should work with pipe chains (compress → decompress roundtrip)', async () => {
    const input = Buffer.from('Another roundtrip test with pipe chains.');
    const compress = createCompressStream();
    const decompress = createDecompressStream();

    const readable = Readable.from([input]);
    const outputStream = readable.pipe(compress).pipe(decompress);

    const result = await collectStream(outputStream);
    expect(result.toString()).toBe(input.toString());
  });

  it('should handle empty input', async () => {
    const input = Buffer.alloc(0);
    const compress = createCompressStream();
    const decompress = createDecompressStream();

    const readable = Readable.from([input]);
    const outputStream = readable.pipe(compress).pipe(decompress);

    const result = await collectStream(outputStream);
    expect(result.length).toBe(0);
  });

  it('should handle large data', async () => {
    const input = crypto.randomBytes(1024 * 100); // 100KB random data
    const compress = createCompressStream();
    const decompress = createDecompressStream();

    const readable = Readable.from([input]);
    const outputStream = readable.pipe(compress).pipe(decompress);

    const result = await collectStream(outputStream);
    expect(result.equals(input)).toBe(true);
  });
});

describe('DEFAULT_BROTLI_OPTIONS', () => {
  it('should have quality set to 3', () => {
    expect(DEFAULT_BROTLI_OPTIONS).toBeDefined();
    expect(DEFAULT_BROTLI_OPTIONS.params).toBeDefined();
    expect(DEFAULT_BROTLI_OPTIONS.params[zlib.constants.BROTLI_PARAM_QUALITY]).toBe(3);
  });
});
