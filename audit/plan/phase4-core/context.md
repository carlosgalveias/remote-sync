# Phase 4 — Core Protocol Rewrite: Context

## Current Files Being Replaced

This section contains the verbatim content of every file that will be rewritten. The implementer must understand what exists today to avoid accidentally dropping working features.

---

### `client/index.js` (264 lines — COMPLETE REWRITE)

```js
'use strict';

const io = require('socket.io-client');
const ss = require('socket.io-stream');
const progress = require('progress-stream');
const fs = require('fs');
const { listFilesFromFolder } = require('../common/files');
const { computeFileChecksum, createHashStream } = require('../common/checksum');
const { createCompressStream } = require('../common/compression');
const { ConcurrencyPool } = require('../common/concurrency');

/**
 * Connect to the remote-sync server via WebSocket.
 * @param {string} server - Hostname or IP
 * @returns {SocketIOClient.Socket}
 */
function connect(server) {
  return io.connect(`ws://${server}:8000`);
}

/**
 * Emit session-init and wait for session-ack from the server.
 * @param {SocketIOClient.Socket} socket
 * @param {object} sessionOpts - { compress, checksum }
 * @returns {Promise<void>}
 */
function initSession(socket, sessionOpts) {
  return new Promise((resolve, reject) => {
    socket.emit('session-init', sessionOpts);
    socket.once('session-ack', () => {
      console.log('[session] Server acknowledged session settings.');
      resolve();
    });
    setTimeout(() => reject(new Error('session-ack timeout')), 15000);
  });
}

/**
 * Execute the resume protocol: send manifest, receive skip/transfer lists.
 * @param {SocketIOClient.Socket} socket
 * @param {Array<{file: string, type: string}>} fileList - Only type==='file' entries
 * @returns {Promise<{skip: string[], transfer: string[]}>}
 */
async function queryResume(socket, fileList) {
  console.log('[resume] Computing checksums for resume query...');
  const manifest = [];
  for (const entry of fileList) {
    const checksum = await computeFileChecksum(entry.file);
    manifest.push({ file: entry.file, checksum });
  }

  return new Promise((resolve, reject) => {
    socket.emit('resume-query', manifest);
    socket.once('resume-response', (response) => {
      resolve(response);
    });
    setTimeout(() => reject(new Error('resume-response timeout')), 30000);
  });
}

/**
 * Send a single file with pre-computed checksum, compression, and retry logic.
 */
function sendFileWithRetry(fileEntry, socket, opts, precomputedChecksum) {
  let attempts = 0;
  const maxAttempts = opts.retries;

  const doSend = () => {
    attempts++;
    return new Promise((resolve, reject) => {
      const filePath = fileEntry.file;
      const fileSize = fs.statSync(filePath).size;

      console.log(`[send] Starting: ${filePath} (attempt ${attempts}/${maxAttempts})`);

      const stream = ss.createStream();

      const progressStream = progress({
        length: fileSize,
        time: 500
      });

      progressStream.on('progress', (p) => {
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        process.stdout.write(
          `[progress] ${filePath} — ${Math.round(p.percentage)}% | ETA: ${p.eta}s`
        );
      });

      const readStream = fs.createReadStream(filePath);

      let pipeline = readStream.pipe(progressStream);

      if (opts.checksum) {
        const hashStream = createHashStream();
        pipeline = pipeline.pipe(hashStream);
      }

      if (opts.compress) {
        const compressStream = createCompressStream();
        pipeline = pipeline.pipe(compressStream);
      }

      const metadata = {
        file: filePath,
        compressed: opts.compress
      };

      if (opts.checksum && precomputedChecksum) {
        metadata.checksum = precomputedChecksum;
      }

      ss(socket).emit('file', stream, metadata);
      pipeline.pipe(stream);

      stream.on('error', (err) => {
        process.stdout.write('\n');
        console.error(`[error] Error sending file: ${filePath}`, err);
        resolve(); // dont reject, move to next file
      });

      if (opts.checksum) {
        const onAck = (ack) => {
          if (ack.file === filePath) {
            socket.removeListener('file-ack', onAck);
            process.stdout.write('\n');
            if (ack.status === 'ok') {
              console.log(`[done] File transferred and verified: ${filePath}`);
              resolve();
            } else {
              console.warn(`[mismatch] Checksum mismatch for: ${filePath}`);
              reject(new Error('CHECKSUM_MISMATCH'));
            }
          }
        };
        socket.on('file-ack', onAck);
      } else {
        pipeline.on('end', () => {
          process.stdout.write('\n');
          console.log(`[done] File transferred: ${filePath}`);
          resolve();
        });
      }
    });
  };

  const attempt = () => {
    return doSend().catch((err) => {
      if (err.message === 'CHECKSUM_MISMATCH' && attempts < maxAttempts) {
        console.log(`[retry] Retrying ${fileEntry.file} (attempt ${attempts + 1}/${maxAttempts})`);
        return attempt();
      }
      throw err;
    });
  };

  return attempt();
}

/**
 * Process the file transfer request.
 */
async function processRequest(server, folder, options = {}) {
  const opts = {
    concurrency: options.concurrency || 5,
    compress: options.compress || false,
    checksum: options.checksum !== undefined ? options.checksum : true,
    retries: options.retries || 3,
    resume: options.resume !== undefined ? options.resume : true
  };

  console.log('[config] Options:', JSON.stringify(opts, null, 2));

  const socket = connect(server);

  socket.on('connect', async () => {
    console.log(`[connected] Connected to server: ${server}`);

    try {
      await initSession(socket, { compress: opts.compress, checksum: opts.checksum });

      const allEntries = listFilesFromFolder(folder);
      const fileList = allEntries.filter((entry) => entry.type === 'file');
      console.log(`[files] Found ${fileList.length} file(s) to process.`);

      let filesToSend = fileList;
      const checksumMap = new Map();

      if (opts.resume && opts.checksum) {
        const resumeResult = await queryResume(socket, fileList);
        const skipSet = new Set(resumeResult.skip || []);
        const transferSet = new Set(resumeResult.transfer || []);

        filesToSend = fileList.filter((entry) => transferSet.has(entry.file));
        console.log(`[resume] Skipping ${skipSet.size} file(s) already on server.`);
        console.log(`[resume] Transferring ${filesToSend.length} file(s).`);
      }

      if (opts.checksum) {
        console.log('[checksum] Computing file checksums...');
        for (const entry of filesToSend) {
          const checksum = await computeFileChecksum(entry.file);
          checksumMap.set(entry.file, checksum);
        }
      }

      if (filesToSend.length === 0) {
        console.log('[done] No files to transfer. All up to date!');
        process.exit(0);
        return;
      }

      const pool = new ConcurrencyPool(opts.concurrency);
      const tasks = filesToSend.map((entry) => {
        return () => {
          const checksum = checksumMap.get(entry.file) || null;
          return sendFileWithRetry(entry, socket, opts, checksum);
        };
      });

      await pool.runAll(tasks);

      console.log('\n[complete] All files transferred!');
      process.exit(0);
    } catch (err) {
      console.error(err)
      console.error('[fatal] Transfer failed:', err.message);
      process.exit(1);
    }
  });

  socket.on('connect_error', (err) => {
    console.error(`[error] Connection failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = processRequest;
```

---

### `server/index.js` (152 lines — COMPLETE REWRITE)

```js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const server = require('socket.io')(8000);
const ss = require('socket.io-stream');
const { computeFileChecksum, createHashStream } = require('../common/checksum');
const { createDecompressStream } = require('../common/compression');

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ name, address: iface.address });
      }
    }
  }
  return addresses;
}

console.log('Server listening on port 8000');
console.log('Available on:');
console.log('  localhost: 127.0.0.1');
const localIPs = getLocalIPs();
for (const { name, address } of localIPs) {
  console.log(`  ${name}: ${address}`);
}
console.log('\nWaiting for connections...');

server.on('connection', (socket) => {
  console.log('Client connected');

  let sessionOptions = { compress: false, checksum: false };

  socket.on('session-init', (options, cb) => {
    sessionOptions.compress = !!options.compress;
    sessionOptions.checksum = !!options.checksum;
    const ack = { ok: true };
    if (typeof cb === 'function') {
      cb(ack);
    } else {
      socket.emit('session-ack', ack);
    }
  });

  socket.on('resume-query', async (manifest, cb) => {
    const skip = [];
    const transfer = [];

    await Promise.all(manifest.map(async (entry) => {
      try {
        await fs.promises.access(entry.file, fs.constants.F_OK);
        const diskChecksum = await computeFileChecksum(entry.file);
        if (diskChecksum === entry.checksum) {
          skip.push(entry.file);
        } else {
          transfer.push(entry.file);
        }
      } catch (err) {
        transfer.push(entry.file);
      }
    }));

    const response = { skip, transfer };
    if (typeof cb === 'function') {
      cb(response);
    } else {
      socket.emit('resume-response', response);
    }
  });

  ss(socket).on('file', (stream, fileData) => {
    const filename = path.basename(fileData.file);
    const dir = path.dirname(fileData.file);
    console.log('Receiving file: ', filename);

    fs.mkdirSync(dir, { recursive: true });

    const writeStream = fs.createWriteStream(fileData.file);
    const compressed = !!fileData.compressed;
    const expectedChecksum = fileData.checksum || null;

    let pipeline = stream;
    let hashStream = null;

    if (compressed) {
      const decompressStream = createDecompressStream();
      pipeline.on('error', (err) => {
        console.error('Stream error: ', err);
      });
      pipeline = pipeline.pipe(decompressStream);
      decompressStream.on('error', (err) => {
        console.error('Decompression error: ', err);
      });
    }

    if (expectedChecksum) {
      hashStream = createHashStream();
      pipeline = pipeline.pipe(hashStream);
      hashStream.on('error', (err) => {
        console.error('Hash stream error: ', err);
      });
    }

    pipeline.pipe(writeStream);

    stream.on('error', (err) => {
      console.error('Stream error: ', err);
    });

    writeStream.on('error', (err) => {
      console.error('Write error: ', err);
    });

    writeStream.on('finish', () => {
      if (expectedChecksum && hashStream) {
        const receivedChecksum = hashStream.getHash();
        if (receivedChecksum === expectedChecksum) {
          socket.emit('file-ack', {
            file: fileData.file,
            status: 'ok',
            expected: expectedChecksum,
            received: receivedChecksum
          });
        } else {
          fs.unlink(fileData.file, (unlinkErr) => {
            if (unlinkErr) {
              console.error('Failed to delete mismatched file: ', unlinkErr);
            }
          });
          socket.emit('file-ack', {
            file: fileData.file,
            status: 'mismatch',
            expected: expectedChecksum,
            received: receivedChecksum
          });
        }
      } else {
        socket.emit('file-ack', {
          file: fileData.file,
          status: 'ok',
          expected: expectedChecksum,
          received: null
        });
      }
    });
  });
});
```

---

### `common/concurrency.js` (60 lines — COMPLETE REWRITE)

```js
'use strict';

class ConcurrencyPool {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }

  run(taskFn) {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this.running++;
        try {
          const result = await taskFn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.running--;
          this._next();
        }
      };

      if (this.running < this.limit) {
        execute();
      } else {
        this.queue.push(execute);
      }
    });
  }

  async runAll(tasks) {
    return Promise.all(tasks.map(task => this.run(task)));
  }

  _next() {
    if (this.queue.length > 0 && this.running < this.limit) {
      const next = this.queue.shift();
      next();
    }
  }
}

module.exports = { ConcurrencyPool };
```

---

### `common/files.js` (35 lines — COMPLETE REWRITE)

```js
'use strict';
const path = require('path');
const fs = require('fs');

const listFilesFromFolder = function(folder, foundFiles) {
  if (!folder) { folder = './'; }
  if (!foundFiles) {
    foundFiles = [];
  }
  let files;
  try {
    files = fs.readdirSync(path.resolve(folder));
  } catch (e) {
    console.warn('cound not read folder', folder);
    return foundFiles;
  }
  for (const file of files) {
    try{
      const filePath = path.join(folder, file);
      const fullPath = path.resolve(filePath);
      if (fs.statSync(filePath).isDirectory()) {
        foundFiles.push({ file: fullPath, type: 'folder' });
        foundFiles = foundFiles.concat(listFilesFromFolder(filePath));
      } else {
        foundFiles.push({ file: fullPath, type: 'file' });
      }
    }catch(err){
      console.error(`[error] Error accessing file ${file}: ${err.message}`);
    }
  }
  return foundFiles;
};

module.exports = {
  listFilesFromFolder
};
```

---

### `common/checksum.js` (40 lines — MINOR MODIFICATION)

```js
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { Transform } = require('stream');

function computeFileChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

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
```

**Modification needed:** Guard `getHash()` against double-call:

```js
function createHashStream() {
  const hash = crypto.createHash('md5');
  let finalized = false;
  let cachedHash = null;
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      this.push(chunk);
      callback();
    }
  });
  transform.getHash = () => {
    if (!finalized) {
      cachedHash = hash.digest('hex');
      finalized = true;
    }
    return cachedHash;
  };
  return transform;
}
```

---

### `common/compression.js` (32 lines — NO CHANGES)

```js
'use strict';

const zlib = require('zlib');

const DEFAULT_BROTLI_OPTIONS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 3
  }
};

function createCompressStream(options = DEFAULT_BROTLI_OPTIONS) {
  return zlib.createBrotliCompress(options);
}

function createDecompressStream() {
  return zlib.createBrotliDecompress();
}

module.exports = { createCompressStream, createDecompressStream, DEFAULT_BROTLI_OPTIONS };
```

This module is correct as-is. In Phase 4, compression will be applied per-chunk using `zlib.brotliCompressSync(chunk, options)` for simplicity (synchronous, per-128KB-chunk — negligible overhead vs. stream setup cost). The stream-based API remains available for Phase 5's large-file streaming if needed.

---

### `index.js` (40 lines — MINOR MODIFICATION)

```js
#!/usr/bin/env node
'use strict';
const { program } = require('commander');

program.version('0.0.1');

program
  .command('receive')
  .description('start a server to receive data')
  .action(() => startServer());

program
  .command('send')
  .description('copy folder recursively to receiver')
  .option('-a, --address <ip>', 'ip address of the receiver', '127.0.0.1')
  .option('-f, --folder <folder>', 'folder to copy', process.cwd())
  .option('-c, --concurrency <number>', 'number of parallel file transfers', '5')
  .option('-z, --compress', 'enable Brotli compression')
  .option('--no-checksum', 'disable MD5 checksum verification')
  .option('-r, --retries <number>', 'max retries per file on checksum mismatch', '3')
  .option('--no-resume', 'disable resume capability')
  .action((options) => {
    startSync(options.address, options.folder, {
      concurrency: parseInt(options.concurrency, 10),
      compress: options.compress || false,
      checksum: options.checksum,
      retries: parseInt(options.retries, 10),
      resume: options.resume
    });
  });

program.parse(process.argv);
```

**Modifications for Phase 4:**
- Fix version: read from package.json or hardcode `'1.0.0'`
- Add `-p, --port <number>` option (default: `'8000'`)
- Validate `concurrency` is a positive integer (NaN guard)
- Pass `port` to both `startServer()` and `startSync()`

---

### `package.json` (48 lines — MODIFICATION)

```json
{
  "name": "remote-sync",
  "version": "0.0.2",
  "description": "Client Server Sync Files and Folders",
  "main": "index.js",
  "bin": {
    "remote-sync": "index.js"
  },
  "scripts": {
    "test": "jest --coverage",
    "test:watch": "jest --watch",
    "test:perf": "node tests/performance/brotli-benchmark.js"
  },
  "author": "",
  "license": "ISC",
  "engines": {
    "node": ">=16.0.0"
  },
  "dependencies": {
    "commander": "^15.0.0",
    "progress-stream": "^2.0.0",
    "socket.io": "^4.8.3",
    "socket.io-client": "^4.8.3",
    "socket.io-stream": "^0.9.1"
  },
  "devDependencies": {
    "@jest/globals": "^30.4.1",
    "jest": "^30.4.2"
  },
  "jest": { ... },
  "overrides": {
    "socket.io-stream": {
      "debug": "^4.3.4"
    }
  }
}
```

**Target state after Phase 4:**

```json
{
  "name": "remote-sync",
  "version": "1.0.0",
  "description": "Fast LAN file transfer with resume and integrity verification",
  "main": "index.js",
  "bin": {
    "remote-sync": "index.js"
  },
  "scripts": {
    "test": "jest --coverage",
    "test:watch": "jest --watch"
  },
  "author": "",
  "license": "ISC",
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "commander": "^15.0.0",
    "socket.io": "^4.8.3",
    "socket.io-client": "^4.8.3"
  },
  "devDependencies": {
    "@jest/globals": "^30.4.1",
    "jest": "^30.4.2"
  },
  "jest": {
    "testEnvironment": "node",
    "coverageDirectory": "coverage",
    "collectCoverageFrom": [
      "common/**/*.js",
      "client/**/*.js",
      "server/**/*.js",
      "index.js"
    ],
    "testMatch": [
      "**/tests/**/*.test.js"
    ]
  }
}
```

Removed: `progress-stream`, `socket.io-stream`, `overrides` block. Bumped version and engine.

---

## Protocol Algorithms (Pseudocode)

### Sender — Single File Transfer

```
function sendFile(socket, fileInfo, options):
  // 1. Emit file-start, get ack with resume offset
  ack = await emitWithAck(socket, 'file-start', {
    fileKey: fileInfo.wireKey,
    size: fileInfo.size,
    mtime: fileInfo.mtime,
    compressed: options.compress,
    checksum: options.checksum
  })

  if !ack.ok:
    return { status: 'rejected', error: ack.error }

  offset = ack.offset || 0  // byte offset for resume (Phase 5)

  // 2. Open read stream from offset
  fd = fs.openSync(fileInfo.absolutePath, 'r')
  hash = options.checksum ? crypto.createHash('md5') : null
  chunkIndex = Math.floor(offset / CHUNK_SIZE)
  bytesRead = offset

  // If resuming, hash the skipped portion first (Phase 5)
  // For Phase 4: offset is always 0

  // 3. Read and send chunks
  buffer = Buffer.allocUnsafe(CHUNK_SIZE)
  while bytesRead < fileInfo.size:
    readSize = Math.min(CHUNK_SIZE, fileInfo.size - bytesRead)
    n = fs.readSync(fd, buffer, 0, readSize, bytesRead)
    chunk = buffer.slice(0, n)

    if hash:
      hash.update(chunk)

    payload = options.compress ? brotliCompressSync(chunk) : chunk

    chunkAck = await emitWithAck(socket, 'file-chunk', {
      fileKey: fileInfo.wireKey,
      index: chunkIndex,
      data: payload
    })

    if !chunkAck.ok:
      fs.closeSync(fd)
      return { status: 'error', error: chunkAck.error }

    bytesRead += n
    chunkIndex++
    callbacks.onChunkSent?.(fileInfo.wireKey, chunkIndex, totalChunks, bytesRead)

  fs.closeSync(fd)

  // 4. Emit file-end
  md5 = hash ? hash.digest('hex') : null
  endAck = await emitWithAck(socket, 'file-end', {
    fileKey: fileInfo.wireKey,
    md5: md5,
    totalChunks: chunkIndex,
    totalBytes: fileInfo.size
  })

  callbacks.onFileComplete?.(fileInfo.wireKey, endAck.status)
  return { status: endAck.status }
```

### Receiver — Chunk Assembly

```
// State per socket connection:
activeFiles = Map<fileKey, { fd, hash, partPath, finalPath, compressed, bytesWritten }>

function handleFileStart(socket, payload, ack):
  fileKey = payload.fileKey

  // Validate path security
  finalPath = fromWireKey(outputDir, fileKey)  // throws if unsafe
  partPath = finalPath + '.part'

  // Create directory structure
  mkdirSync(path.dirname(finalPath), { recursive: true })

  // Check for existing .part (resume — Phase 5, always 0 in Phase 4)
  offset = 0
  // Phase 5: offset = existsSync(partPath) ? statSync(partPath).size : 0

  // Open file for writing (truncate in Phase 4, append in Phase 5)
  fd = fs.openSync(partPath, 'w')  // Phase 5: offset > 0 ? 'a' : 'w'
  hash = payload.checksum ? crypto.createHash('md5') : null

  activeFiles.set(fileKey, { fd, hash, partPath, finalPath, compressed: payload.compressed, bytesWritten: 0 })
  ack({ ok: true, offset: offset })

function handleFileChunk(socket, payload, ack):
  fileKey = payload.fileKey
  state = activeFiles.get(fileKey)
  if !state:
    ack({ ok: false, error: 'no active transfer for this key' })
    return

  // Decompress if needed
  data = state.compressed ? brotliDecompressSync(payload.data) : payload.data

  // Update hash
  if state.hash:
    state.hash.update(data)

  // Write to .part file
  fs.writeSync(state.fd, data)
  state.bytesWritten += data.length

  ack({ ok: true })

function handleFileEnd(socket, payload, ack):
  fileKey = payload.fileKey
  state = activeFiles.get(fileKey)
  if !state:
    ack({ ok: false, error: 'no active transfer for this key' })
    return

  // Verify checksum
  if state.hash && payload.md5:
    receivedMd5 = state.hash.digest('hex')
    if receivedMd5 !== payload.md5:
      // Checksum mismatch — delete .part, report error
      fs.closeSync(state.fd)
      fs.unlinkSync(state.partPath)
      activeFiles.delete(fileKey)
      ack({ ok: false, status: 'checksum_mismatch', expected: payload.md5, received: receivedMd5 })
      return

  // Atomic commit: fsync + rename
  fs.fsyncSync(state.fd)
  fs.closeSync(state.fd)
  fs.renameSync(state.partPath, state.finalPath)

  activeFiles.delete(fileKey)
  ack({ ok: true, status: 'verified' })
```

### Path Normalization

```
function toWireKey(rootFolder, absolutePath):
  // rootFolder: 'C:\Users\alice\project'
  // absolutePath: 'C:\Users\alice\project\src\index.js'
  relative = path.relative(rootFolder, absolutePath)
  // relative: 'src\index.js' (on Windows)
  wireKey = relative.split(path.sep).join('/')
  // wireKey: 'src/index.js'

  // Validate: must not start with '/' or contain '..'
  if wireKey.startsWith('/') or wireKey.includes('..'):
    throw new Error(`Unsafe path: ${wireKey}`)

  return wireKey

function fromWireKey(outputDir, wireKey):
  // wireKey: 'src/index.js'
  // outputDir: '/home/bob/received'

  // Reject obviously malicious keys
  if wireKey.includes('..') or wireKey.startsWith('/') or wireKey.includes('\\'):
    throw new Error(`Rejected unsafe fileKey: ${wireKey}`)

  // Join and resolve
  joined = path.join(outputDir, wireKey)
  resolved = path.resolve(joined)

  // Final check: must be within outputDir
  resolvedOutput = path.resolve(outputDir)
  if !resolved.startsWith(resolvedOutput + path.sep) and resolved !== resolvedOutput:
    throw new Error(`Path escape attempt: ${wireKey} resolves to ${resolved}`)

  return resolved
```

### ConcurrencyPool — runAllSettled

```
class ConcurrencyPool:
  constructor(limit, callbacks = {}):
    this.limit = limit
    this.running = 0
    this.queue = []
    this.callbacks = callbacks

  async runAllSettled(tasks):
    succeeded = []
    failed = []

    promises = tasks.map((taskFn, index) => {
      return this.run(async () => {
        try:
          result = await taskFn()
          succeeded.push(result)
          this.callbacks.onTaskComplete?.(result, index)
        catch (err):
          failed.push({ index, error: err })
          this.callbacks.onTaskError?.(err, index)
      })
    })

    await Promise.all(promises)  // Never rejects because inner try/catch
    return { succeeded, failed }
```

### emitWithAck (Socket.IO Acknowledgements)

```
function emitWithAck(socket, event, payload, timeoutMs = 30000):
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ack on '${event}'`))
    }, timeoutMs)

    socket.emit(event, payload, (response) => {
      clearTimeout(timer)
      resolve(response)
    })
  })
```

Note: Socket.IO v4 supports native timeout on acks via `socket.timeout(ms).emit(event, payload, callback)`. Use this instead if available in the version we're using:

```js
// Preferred Socket.IO v4.4+ approach:
const response = await socket.timeout(timeoutMs).emitWithAck(event, payload);
```

---

## Audit Defects Fixed by This Phase

| Defect | Description | How Fixed |
|--------|-------------|-----------|
| DEF-001 | `process.exit(1)` on `connect_error` | Removed. Connection wrapper handles retries gracefully. |
| DEF-002 | No reconnection/re-queue | Connection module manages state. Orchestrator awaits connection. |
| DEF-003 | `Promise.all` fail-fast | Replaced with `runAllSettled` — per-task isolation. |
| DEF-004 | `maxHttpBufferSize` 1MB default | Server factory sets 100MB explicitly. |
| DEF-005 | Resume blocks event loop | Moved to Phase 5 but the server config (pingTimeout 120s) prevents self-disconnect. |
| DEF-008 | Absolute paths as wire keys | `toWireKey()` / `fromWireKey()` with POSIX relative paths. |
| DEF-009 | Triple hashing | Single incremental hash during transfer. No pre-computation. |
| DEF-012 | Direct write to final path | Atomic: write to `.part`, fsync, rename. |
| DEF-013 | O(n²) file-ack listeners | Ack callbacks per-emit. No listener accumulation. |
| DEF-014 | No error handler on readStream | `fs.openSync`/`readSync` with try/catch. Errors caught at chunk level. |
| DEF-015 | Manual `.pipe()` chains | No pipes. Synchronous chunk read → compress → emit. |
| DEF-016 | pingTimeout too short | 120s configured in server factory. |
| DEF-019 | socket.io-stream dependency | Completely removed. Native Socket.IO binary. |
| DEF-020 | Version mismatch | Fixed in `index.js` and `package.json`. |
| DEF-022 | Arbitrary file write | `fromWireKey()` validates paths within output directory. |
| ADD-002 | TTY crash on `clearLine` | Progress module not used in Phase 4 (placeholder logs only). |
| ADD-005 | Stale pre-computed checksum | No pre-computation. Hash computed as data is read. |
| ADD-006 | Server binds on `require()` | Server factory pattern with explicit `listen()` call. |
| ADD-007 | NaN concurrency hangs | Input validation in CLI parser. |

---

## Why Synchronous Chunk Read Instead of Streams?

The old code used Node.js streams (`createReadStream` → pipe chain → socket.io-stream). This caused:
- No backpressure (pipes don't propagate it across socket.io-stream boundary)
- Error propagation nightmare (5-stage pipe chain, any can fail independently)
- Memory unpredictability (buffering between pipe stages)

The new design uses **synchronous file reads** (`fs.readSync`) in an **async loop**:

```js
while (bytesRead < fileSize) {
  const n = fs.readSync(fd, buffer, 0, chunkSize, bytesRead);  // sync read
  const ack = await emitWithAck(socket, 'file-chunk', ...);     // async wait
  bytesRead += n;
}
```

**Why this is superior:**
1. **Memory bounded:** Exactly 1 buffer (128KB) per concurrent file. Total: 5 × 128KB = 640KB.
2. **Natural backpressure:** The `await emitWithAck` blocks until the receiver has written the chunk. Sender never outpaces receiver.
3. **Error handling is trivial:** If `readSync` throws → catch → report. If `emitWithAck` rejects → catch → report. No stream error event spaghetti.
4. **Testable:** Mock `fs.readSync` and `socket.emit` independently. No stream lifecycle to simulate.

**Why not streaming?** Because this is LAN transfer, not HTTP streaming. The bottleneck is network bandwidth, not disk seek time. Reading 128KB synchronously takes <1ms on any modern disk. The `await emitWithAck` takes 0.1-50ms depending on network. The sync read is invisible in the timing profile.

---

## Compression Strategy Detail

**Per-chunk independent compression using `zlib.brotliCompressSync`:**

```js
const zlib = require('zlib');
const BROTLI_OPTIONS = {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 3 }
};

function compressChunk(chunk) {
  return zlib.brotliCompressSync(chunk, BROTLI_OPTIONS);
}

function decompressChunk(compressed) {
  return zlib.brotliDecompressSync(compressed);
}
```

**Why per-chunk, not whole-file streaming compression?**
1. Each chunk can be independently decompressed → enables byte-offset resume at chunk boundaries
2. A corrupt compressed chunk doesn't invalidate subsequent chunks
3. Synchronous compression of 128KB takes ~1-3ms at quality 3 — negligible
4. No Brotli stream state to track across disconnect/reconnect

**Trade-off:** Per-chunk compression gets slightly worse compression ratio than whole-file (no cross-chunk dictionary). For LAN transfer at quality 3, the difference is <5%. Acceptable.
