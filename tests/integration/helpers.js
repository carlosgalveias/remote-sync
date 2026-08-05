'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { createServer } = require('../../server/server');

/**
 * Get a random available port on localhost.
 * @returns {Promise<number>}
 */
function getRandomPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

/**
 * Create a temporary directory with a unique name.
 * @param {string} prefix - Directory name prefix
 * @returns {string} Absolute path to the created temp directory
 */
function createTempDir(prefix = 'remote-sync-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/**
 * Remove a directory and all contents recursively.
 * @param {string} dirPath - Directory to remove
 */
function cleanupDir(dirPath) {
  if (dirPath && fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * Generate a file tree in the given directory with various sizes.
 * @param {string} dir - Target directory
 * @param {number} count - Number of files to generate
 * @param {object} [options]
 * @param {boolean} [options.nested=true] - Create nested subdirectories
 * @returns {Array<{relativePath: string, size: number, content: Buffer}>}
 */
function generateFileTree(dir, count, options = {}) {
  const nested = options.nested !== false;
  const files = [];

  // Distribute files across size categories
  for (let i = 0; i < count; i++) {
    let size;
    let subdir = '';

    if (i % 100 === 0 && i > 0) {
      // ~1% large files: 100KB - 500KB
      size = 100 * 1024 + Math.floor(Math.random() * 400 * 1024);
    } else if (i % 10 === 0) {
      // ~10% medium files: 10KB - 100KB
      size = 10 * 1024 + Math.floor(Math.random() * 90 * 1024);
    } else if (i % 5 === 0) {
      // ~20% very small files (1-100 bytes)
      size = 1 + Math.floor(Math.random() * 100);
    } else {
      // ~70% tiny files: 1 - 10KB
      size = 1 + Math.floor(Math.random() * 10 * 1024);
    }

    if (nested) {
      const depth = Math.floor(Math.random() * 3);
      const parts = [];
      for (let d = 0; d < depth; d++) {
        parts.push(`dir${Math.floor(Math.random() * 5)}`);
      }
      subdir = parts.join('/');
    }

    const filename = `file-${String(i).padStart(4, '0')}.dat`;
    const relativePath = subdir ? `${subdir}/${filename}` : filename;
    const content = size > 0 ? crypto.randomBytes(size) : Buffer.alloc(0);

    const fullPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);

    files.push({ relativePath, size, content });
  }

  return files;
}

/**
 * Generate a specific number of files with exact sizes.
 * @param {string} dir - Target directory
 * @param {Array<{name: string, size: number}>} specs - File specifications
 * @returns {Array<{relativePath: string, size: number, absolutePath: string}>}
 */
function generateFiles(dir, specs) {
  const files = [];
  for (const spec of specs) {
    const content = spec.size > 0 ? crypto.randomBytes(spec.size) : Buffer.alloc(0);
    const fullPath = path.join(dir, spec.name);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    files.push({
      relativePath: spec.name,
      size: spec.size,
      absolutePath: fullPath
    });
  }
  return files;
}

/**
 * Start a receiver server on a random port.
 * @param {string} outputDir - Output directory for received files
 * @param {object} [opts] - Additional options
 * @returns {Promise<{port: number, close: () => Promise<void>, io: any, httpServer: any}>}
 */
async function startTestServer(outputDir, opts = {}) {
  const port = opts.port || await getRandomPort();
  const server = await createServer({
    port,
    outputDir,
    onConnection: opts.onConnection || null
  });
  return { port, ...server };
}

/**
 * Wait for a condition to be true with timeout.
 * @param {function} conditionFn - Returns true when condition is met
 * @param {number} [timeout=10000] - Max wait time in ms
 * @param {number} [interval=50] - Check interval in ms
 * @returns {Promise<void>}
 */
async function waitFor(conditionFn, timeout = 10000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await conditionFn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}

/**
 * Verify that files were received correctly by comparing with source.
 * @param {string} sourceDir - Source directory
 * @param {string} destDir - Destination directory
 * @param {Array<{relativePath: string}>} files - Files to verify
 * @returns {{matched: number, mismatched: string[], missing: string[]}}
 */
function verifyTransfer(sourceDir, destDir, files) {
  let matched = 0;
  const mismatched = [];
  const missing = [];

  for (const file of files) {
    const srcPath = path.join(sourceDir, file.relativePath);
    const dstPath = path.join(destDir, file.relativePath);

    if (!fs.existsSync(dstPath)) {
      missing.push(file.relativePath);
      continue;
    }

    const srcContent = fs.readFileSync(srcPath);
    const dstContent = fs.readFileSync(dstPath);

    if (srcContent.equals(dstContent)) {
      matched++;
    } else {
      mismatched.push(file.relativePath);
    }
  }

  return { matched, mismatched, missing };
}

/**
 * Run the sender (client) programmatically.
 * @param {object} params
 * @param {string} params.folder - Source folder
 * @param {number} params.port - Server port
 * @param {object} [params.options] - Transfer options
 * @returns {Promise<{succeeded: any[], failed: any[], skipped: number, exitCode: number}>}
 */
async function runSender(params) {
  const { runSendSession } = require('../../client/index');
  return runSendSession({
    address: '127.0.0.1',
    port: params.port,
    folder: params.folder,
    options: {
      concurrency: params.options?.concurrency || 5,
      compress: params.options?.compress || false,
      checksum: params.options?.checksum !== false,
      retries: params.options?.retries != null ? params.options.retries : 3,
      resume: params.options?.resume !== false,
      stallTimeout: params.options?.stallTimeout || 5000,
      graceTimeout: params.options?.graceTimeout || 3000,
      timeout: params.options?.timeout != null ? params.options.timeout : 10000,
      globalTimeout: params.options?.globalTimeout || 0,
      dryRun: false,
      verbose: false,
      quiet: true,
      logFile: null
    }
  });
}

module.exports = {
  getRandomPort,
  createTempDir,
  cleanupDir,
  generateFileTree,
  generateFiles,
  startTestServer,
  waitFor,
  verifyTransfer,
  runSender
};
