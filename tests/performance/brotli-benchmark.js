#!/usr/bin/env node
'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const { createCompressStream, createDecompressStream, DEFAULT_BROTLI_OPTIONS } = require('../../common/compression');
const { Readable, Writable, pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ITERATIONS = 3;
const QUICK_MODE = process.argv.includes('--quick');
const SIZES_MB = QUICK_MODE ? [1, 10] : [1, 10, 100];
const BROTLI_QUALITY = DEFAULT_BROTLI_OPTIONS.params[zlib.constants.BROTLI_PARAM_QUALITY];

// ---------------------------------------------------------------------------
// Data generators
// ---------------------------------------------------------------------------

/**
 * Generates a buffer of text patterns resembling source code (highly compressible).
 * Uses varied identifiers and structure to simulate real code compression ratios.
 * @param {number} sizeBytes - Target size in bytes
 * @returns {Buffer}
 */
function generateTextData(sizeBytes) {
  const keywords = ['function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'class'];
  const identifiers = ['handler', 'processor', 'manager', 'service', 'controller', 'factory', 'builder', 'resolver'];
  const types = ['string', 'number', 'boolean', 'object', 'array', 'null', 'undefined'];
  const methods = ['getData', 'setConfig', 'initialize', 'validate', 'transform', 'serialize', 'parse', 'render'];

  const chunks = [];
  let totalSize = 0;
  let counter = 0;

  while (totalSize < sizeBytes) {
    counter++;
    const id = identifiers[counter % identifiers.length];
    const method = methods[counter % methods.length];
    const kw = keywords[counter % keywords.length];
    const type = types[counter % types.length];

    const block = [
      `${kw} ${id}${counter} = require('./${method}');\n`,
      `\n`,
      `/**\n`,
      ` * Processes ${type} data for ${id} module (v${counter}).\n`,
      ` * @param {${type}} input - The input ${type} to process\n`,
      ` * @returns {object} Processed result with metadata\n`,
      ` */\n`,
      `function ${method}${counter}(input, opts = {}) {\n`,
      `  const config = { timeout: ${1000 + counter}, retries: ${counter % 5} };\n`,
      `  let result = null;\n`,
      `  \n`,
      `  if (typeof input === '${type}') {\n`,
      `    result = ${id}${counter}.${method}(input, config);\n`,
      `  } else if (opts.fallback) {\n`,
      `    result = opts.fallback(input);\n`,
      `  } else {\n`,
      `    throw new Error('Invalid input type: expected ${type}');\n`,
      `  }\n`,
      `  \n`,
      `  return {\n`,
      `    data: result,\n`,
      `    timestamp: Date.now(),\n`,
      `    source: '${id}',\n`,
      `    version: ${counter}\n`,
      `  };\n`,
      `}\n`,
      `\n`,
      `module.exports = { ${method}${counter} };\n\n`
    ].join('');

    chunks.push(block);
    totalSize += Buffer.byteLength(block);
  }

  return Buffer.from(chunks.join('')).subarray(0, sizeBytes);
}

/**
 * Generates a buffer of structured JSON data (medium compressible).
 * Contains repeated keys with varying values.
 * @param {number} sizeBytes - Target size in bytes
 * @returns {Buffer}
 */
function generateJsonData(sizeBytes) {
  const entries = [];
  let totalSize = 2; // account for [ and ]
  let id = 0;

  while (totalSize < sizeBytes) {
    const entry = JSON.stringify({
      id: id++,
      name: `user_${id}_${crypto.randomBytes(4).toString('hex')}`,
      email: `user${id}@example.com`,
      active: id % 3 !== 0,
      score: Math.random() * 100,
      tags: ['alpha', 'beta', 'gamma'].slice(0, (id % 3) + 1),
      metadata: {
        created: '2026-01-15T10:30:00Z',
        modified: '2026-08-01T14:22:00Z',
        version: id % 5
      }
    });

    if (totalSize + entry.length + 1 > sizeBytes) break;
    entries.push(entry);
    totalSize += entry.length + 1; // +1 for comma
  }

  const json = `[${entries.join(',')}]`;
  const buf = Buffer.from(json);

  // Pad or trim to exact size
  if (buf.length >= sizeBytes) {
    return buf.subarray(0, sizeBytes);
  }

  // Pad with spaces (still valid-ish, keeps it JSON-like)
  const padded = Buffer.alloc(sizeBytes, 0x20);
  buf.copy(padded);
  return padded;
}

/**
 * Generates a buffer of random bytes (incompressible).
 * @param {number} sizeBytes - Target size in bytes
 * @returns {Buffer}
 */
function generateBinaryData(sizeBytes) {
  return crypto.randomBytes(sizeBytes);
}

/**
 * Generates a mixed buffer — alternating text and random binary chunks.
 * @param {number} sizeBytes - Target size in bytes
 * @returns {Buffer}
 */
function generateMixedData(sizeBytes) {
  const chunkSize = 4096;
  const chunks = [];
  let remaining = sizeBytes;

  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    if (chunks.length % 2 === 0) {
      // Text chunk
      chunks.push(generateTextData(size));
    } else {
      // Binary chunk
      chunks.push(crypto.randomBytes(size));
    }
    remaining -= size;
  }

  return Buffer.concat(chunks, sizeBytes);
}

// ---------------------------------------------------------------------------
// Benchmark utilities
// ---------------------------------------------------------------------------

/**
 * Creates a Writable stream that discards all data (null sink).
 * Tracks total bytes written.
 * @returns {Writable & { bytesWritten: number }}
 */
function createNullSink() {
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      sink.bytesWritten += chunk.length;
      callback();
    }
  });
  sink.bytesWritten = 0;
  return sink;
}

/**
 * Measures compression of a buffer and returns timing + compressed size.
 * @param {Buffer} data - Input data to compress
 * @returns {Promise<{ timeMs: number, compressedSize: number }>}
 */
async function measureCompression(data) {
  const sink = createNullSink();
  const compressor = createCompressStream();

  const start = process.hrtime.bigint();
  await pipelineAsync(Readable.from(data), compressor, sink);
  const end = process.hrtime.bigint();

  const timeMs = Number(end - start) / 1e6;
  return { timeMs, compressedSize: sink.bytesWritten };
}

/**
 * Compresses data synchronously to get compressed buffer for decompression test.
 * @param {Buffer} data - Input data
 * @returns {Buffer}
 */
function compressSync(data) {
  return zlib.brotliCompressSync(data, DEFAULT_BROTLI_OPTIONS);
}

/**
 * Measures decompression of a compressed buffer.
 * @param {Buffer} compressedData - Compressed data to decompress
 * @returns {Promise<{ timeMs: number, decompressedSize: number }>}
 */
async function measureDecompression(compressedData) {
  const sink = createNullSink();
  const decompressor = createDecompressStream();

  const start = process.hrtime.bigint();
  await pipelineAsync(Readable.from(compressedData), decompressor, sink);
  const end = process.hrtime.bigint();

  const timeMs = Number(end - start) / 1e6;
  return { timeMs, decompressedSize: sink.bytesWritten };
}

/**
 * Runs a benchmark for a given data buffer, averaging over ITERATIONS runs.
 * @param {Buffer} data - Test data
 * @returns {Promise<{ ratio: number, compressMBps: number, decompressMBps: number, breakEvenMbps: number|null, compressTimeMs: number, decompressTimeMs: number }>}
 */
async function benchmark(data) {
  const originalSizeMB = data.length / (1024 * 1024);

  // Pre-compress for decompression benchmarks
  const compressed = compressSync(data);
  const ratio = data.length / compressed.length;

  let totalCompressTime = 0;
  let totalDecompressTime = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const compResult = await measureCompression(data);
    totalCompressTime += compResult.timeMs;

    const decompResult = await measureDecompression(compressed);
    totalDecompressTime += decompResult.timeMs;
  }

  const avgCompressTimeMs = totalCompressTime / ITERATIONS;
  const avgDecompressTimeMs = totalDecompressTime / ITERATIONS;

  const compressMBps = (originalSizeMB / avgCompressTimeMs) * 1000;
  const decompressMBps = (originalSizeMB / avgDecompressTimeMs) * 1000;

  // Break-even calculation:
  // Compression is beneficial when: compress_time + decompress_time < (original - compressed) / network_speed
  // Solving for network_speed: network_speed < (original - compressed) / (compress_time + decompress_time)
  // If ratio <= 1.05, compression isn't beneficial
  let breakEvenMbps = null;
  if (ratio > 1.05) {
    const savedBytes = data.length - compressed.length;
    const totalOverheadSeconds = (avgCompressTimeMs + avgDecompressTimeMs) / 1000;
    // network_speed = savedBytes / totalOverheadSeconds (in bytes/s), convert to Mbps
    const breakEvenBytesPerSec = savedBytes / totalOverheadSeconds;
    breakEvenMbps = (breakEvenBytesPerSec * 8) / (1024 * 1024);
  }

  return {
    ratio,
    compressMBps,
    decompressMBps,
    breakEvenMbps,
    compressTimeMs: avgCompressTimeMs,
    decompressTimeMs: avgDecompressTimeMs
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Pads a string to a fixed width (center-aligned).
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function center(str, width) {
  const pad = Math.max(0, width - str.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

/**
 * Prints results table for a data type.
 * @param {string} dataType
 * @param {Array<{ sizeMB: number, result: object }>} results
 */
function printDataTypeTable(dataType, results) {
  console.log(`\nData Type: ${dataType}`);
  console.log('-------------------------------------------------------------');
  console.log('Size (MB) | Ratio | Compress (MB/s) | Decompress (MB/s) | Break-even');

  for (const { sizeMB, result } of results) {
    const size = center(String(sizeMB), 9);
    const ratio = center(`${result.ratio.toFixed(1)}x`, 5);
    const compress = center(result.compressMBps.toFixed(0), 15);
    const decompress = center(result.decompressMBps.toFixed(0), 17);
    const breakEven = result.breakEvenMbps !== null
      ? center(`${result.breakEvenMbps.toFixed(0)} Mbps`, 10)
      : center('N/A', 10);

    console.log(`${size} | ${ratio} | ${compress} | ${decompress} | ${breakEven}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=============================================================');
  console.log('  remote-sync Brotli Compression Benchmark');
  console.log(`  Quality: ${BROTLI_QUALITY} (speed-optimized for LAN)`);
  console.log('=============================================================');

  if (QUICK_MODE) {
    console.log('  [--quick mode: skipping 100 MB tests]');
  }

  console.log(`  Iterations per test: ${ITERATIONS}`);
  console.log(`  Test sizes: ${SIZES_MB.join(', ')} MB`);
  console.log('');

  const dataTypes = [
    { name: 'Text/Code', generator: generateTextData },
    { name: 'JSON', generator: generateJsonData },
    { name: 'Binary/Random', generator: generateBinaryData },
    { name: 'Mixed', generator: generateMixedData }
  ];

  const allResults = [];

  for (const { name, generator } of dataTypes) {
    const typeResults = [];

    for (const sizeMB of SIZES_MB) {
      const sizeBytes = sizeMB * 1024 * 1024;

      process.stdout.write(`  Benchmarking ${name} @ ${sizeMB} MB...`);
      const data = generator(sizeBytes);
      const result = await benchmark(data);
      typeResults.push({ sizeMB, result });
      console.log(` done (ratio: ${result.ratio.toFixed(1)}x)`);
    }

    allResults.push({ name, results: typeResults });
  }

  // Print formatted results
  console.log('\n=============================================================');
  console.log('  RESULTS');
  console.log('=============================================================');

  for (const { name, results } of allResults) {
    printDataTypeTable(name, results);
  }

  // Recommendations
  console.log('\n=============================================================');
  console.log('RECOMMENDATIONS:');

  // Find average text break-even
  const textResults = allResults.find(r => r.name === 'Text/Code');
  const jsonResults = allResults.find(r => r.name === 'JSON');

  let textBreakEven = 0;
  let jsonBreakEven = 0;

  if (textResults) {
    const breakEvens = textResults.results
      .map(r => r.result.breakEvenMbps)
      .filter(v => v !== null);
    if (breakEvens.length > 0) {
      textBreakEven = breakEvens.reduce((a, b) => a + b, 0) / breakEvens.length;
    }
  }

  if (jsonResults) {
    const breakEvens = jsonResults.results
      .map(r => r.result.breakEvenMbps)
      .filter(v => v !== null);
    if (breakEvens.length > 0) {
      jsonBreakEven = breakEvens.reduce((a, b) => a + b, 0) / breakEvens.length;
    }
  }

  const maxBreakEven = Math.max(textBreakEven, jsonBreakEven);

  if (maxBreakEven > 0) {
    console.log(`- Enable compression (-z) for text-heavy transfers on networks < ${Math.ceil(maxBreakEven)} Mbps`);
  }
  console.log('- Skip compression for binary/random data (ratio ≈ 1.0x)');

  // Calculate overhead per MB on gigabit
  if (textResults && textResults.results.length > 0) {
    const first = textResults.results[0].result;
    const overheadPerMB = first.compressTimeMs + first.decompressTimeMs;
    console.log(`- On Gigabit LAN: compression adds ~${overheadPerMB.toFixed(1)} ms overhead per MB`);
  }

  console.log('=============================================================');
  console.log('');
  console.log('NOTE: Results vary by CPU, memory bandwidth, and environment.');
  console.log('      Run multiple times for stable numbers.');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
