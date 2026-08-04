'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable, PassThrough } = require('stream');
const { pipeline } = require('stream/promises');
const { computeFileChecksum, createHashStream } = require('../../common/checksum');

const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const SAMPLE_FILE = path.join(FIXTURES_DIR, 'sample.txt');

describe('computeFileChecksum', () => {
  it('should return correct MD5 for a known file', async () => {
    // Read actual file content to compute expected hash (handles OS line endings)
    const fileContent = fs.readFileSync(SAMPLE_FILE);
    const expected = crypto.createHash('md5').update(fileContent).digest('hex');
    const result = await computeFileChecksum(SAMPLE_FILE);
    expect(result).toBe(expected);
  });

  it('should reject for non-existent file', async () => {
    const fakePath = path.join(FIXTURES_DIR, 'does-not-exist.txt');
    await expect(computeFileChecksum(fakePath)).rejects.toThrow();
  });

  it('should handle empty files', async () => {
    const emptyFile = path.join(FIXTURES_DIR, 'empty.tmp');
    fs.writeFileSync(emptyFile, '');
    try {
      const expected = crypto.createHash('md5').update('').digest('hex');
      const result = await computeFileChecksum(emptyFile);
      expect(result).toBe(expected);
    } finally {
      fs.unlinkSync(emptyFile);
    }
  });
});

describe('createHashStream', () => {
  it('should pass data through unchanged', async () => {
    const hashStream = createHashStream();
    const input = Buffer.from('test data for passthrough');
    const chunks = [];

    await new Promise((resolve, reject) => {
      const readable = Readable.from([input]);
      readable.pipe(hashStream);
      hashStream.on('data', (chunk) => chunks.push(chunk));
      hashStream.on('end', resolve);
      hashStream.on('error', reject);
    });

    const output = Buffer.concat(chunks);
    expect(output.equals(input)).toBe(true);
  });

  it('should compute correct MD5 after stream ends', async () => {
    const hashStream = createHashStream();
    const input = Buffer.from('hello world');
    const expected = crypto.createHash('md5').update(input).digest('hex');

    await new Promise((resolve, reject) => {
      const readable = Readable.from([input]);
      readable.pipe(hashStream);
      hashStream.on('data', () => {}); // consume data
      hashStream.on('end', resolve);
      hashStream.on('error', reject);
    });

    expect(hashStream.getHash()).toBe(expected);
  });

  it('should work in a pipe chain', async () => {
    const hashStream = createHashStream();
    const passThrough = new PassThrough();
    const input = Buffer.from('pipe chain test content');
    const expected = crypto.createHash('md5').update(input).digest('hex');
    const chunks = [];

    await new Promise((resolve, reject) => {
      const readable = Readable.from([input]);
      readable.pipe(hashStream).pipe(passThrough);
      passThrough.on('data', (chunk) => chunks.push(chunk));
      passThrough.on('end', resolve);
      passThrough.on('error', reject);
    });

    const output = Buffer.concat(chunks);
    expect(output.equals(input)).toBe(true);
    expect(hashStream.getHash()).toBe(expected);
  });
});
