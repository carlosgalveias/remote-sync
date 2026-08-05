# Phase 4 — Core Protocol Rewrite: Requirements

## Scope

Complete replacement of the transfer protocol layer. Remove `socket.io-stream` dependency. Implement chunked binary transfer over plain Socket.IO v4 with proper server configuration, path normalization, atomic writes, and error propagation.

---

## Files to Create

| File | Purpose |
|------|---------|
| `common/protocol.js` | Shared constants: event names, chunk size, message schemas |
| `client/connection.js` | Socket.IO client wrapper (connect, disconnect state, event helpers) |
| `client/sender.js` | File chunking + sending logic (single file transfer) |
| `server/server.js` | Socket.IO server factory (configurable port, options) |
| `server/receiver.js` | Chunk reassembly + atomic write logic |

## Files to Rewrite (complete replacement)

| File | Reason |
|------|--------|
| `client/index.js` | Orchestrator rewrite — remove socket.io-stream, rewire everything |
| `server/index.js` | Use server factory, register handlers via receiver module |
| `common/concurrency.js` | Replace Promise.all with allSettled + per-task isolation |
| `common/files.js` | Add relative path normalization, fix POSIX conversion |

## Files to Modify

| File | Change |
|------|--------|
| `index.js` | Fix version to match package.json, add `-p/--port` option |
| `package.json` | Remove `socket.io-stream`, `progress-stream`, bump engine to >=18 |
| `common/checksum.js` | Guard against double-digest in `createHashStream` |

## Files to Delete

None. Old files are overwritten in place.

---

## Design Decisions

### 1. Chunked Binary Protocol

**Chunk size: 128KB (131,072 bytes)**

Justification:
- 64KB is too small: at 5 concurrent streams, Socket.IO processes 5×15,000 chunks for a 1GB transfer = 75,000 events. Too much event overhead.
- 256KB approaches Socket.IO's internal buffer thresholds and increases memory per in-flight chunk.
- 128KB is the sweet spot: 1GB file = ~8,000 chunks. At 5 concurrency = 40,000 events total. Socket.IO handles this comfortably. Each chunk fits in a single WebSocket frame.

**Compression strategy: per-chunk, independent**

Each chunk is compressed independently with Brotli (quality 3). This allows:
- The receiver to decompress and write each chunk immediately (no buffering entire file)
- Byte-offset resume to work (resume at chunk boundary, not raw byte boundary)
- A corrupt chunk to be detected and retried without invalidating the entire stream

**Checksum strategy: incremental MD5, reported at file-end**

The sender computes MD5 incrementally as chunks are read. The final hash is sent in the `file-end` message. The receiver also computes MD5 incrementally as chunks are written to the `.part` file. On `file-end`, receiver compares hashes. No pre-computation pass needed — the hash is a byproduct of the transfer itself.

This eliminates DEF-009 (triple hashing) entirely.

### 2. Message Format (Socket.IO Events)

All messages use Socket.IO's native emit with acknowledgement callbacks where noted.

#### `file-start` (client → server)

```js
{
  event: 'file-start',
  payload: {
    fileKey: 'src/utils/helper.js',  // POSIX-relative path (wire format)
    size: 1048576,                    // total file size in bytes
    mtime: 1720000000000,            // file mtime as Unix ms timestamp
    compressed: true,                 // whether chunks are brotli-compressed
    checksum: true                    // whether MD5 will be sent at end
  }
}
// Server responds with ack callback: { ok: true, offset: 0 }
// If resuming: { ok: true, offset: 65536 } (byte offset of existing .part)
```

#### `file-chunk` (client → server)

```js
{
  event: 'file-chunk',
  payload: {
    fileKey: 'src/utils/helper.js',
    index: 0,                         // chunk sequence number (0-based)
    data: <Buffer>                    // raw or compressed chunk bytes
  }
}
// Server responds with ack callback: { ok: true }
// Ack serves as backpressure signal — sender waits for ack before sending next chunk
```

#### `file-end` (client → server)

```js
{
  event: 'file-end',
  payload: {
    fileKey: 'src/utils/helper.js',
    md5: 'a1b2c3d4e5f6...',          // hex string, null if checksum disabled
    totalChunks: 8,
    totalBytes: 1048576               // original (uncompressed) size
  }
}
// Server responds with ack callback: { ok: true, status: 'verified' }
// Or: { ok: false, status: 'checksum_mismatch', expected: '...', received: '...' }
```

#### `session-init` (client → server)

```js
{
  event: 'session-init',
  payload: {
    sessionId: 'uuid-v4',            // unique per client run
    compress: true,
    checksum: true
  }
}
// Server responds with ack callback: { ok: true }
```

#### `transfer-complete` (client → server)

```js
{
  event: 'transfer-complete',
  payload: {
    sessionId: 'uuid-v4',
    totalFiles: 150,
    totalBytes: 52428800
  }
}
// Server responds with ack callback: { ok: true }
// Server can then clean up session state
```

### 3. Path Normalization

**Wire format:** POSIX-relative paths. Always forward slashes. Never starts with `/` or contains `..`.

**Conversion:**
- **Sender (client):** Takes folder root (e.g., `C:\Users\alice\project`). For each file, computes path relative to root using `path.relative(root, filePath)`. Converts to POSIX with `.split(path.sep).join('/')`.
- **Receiver (server):** Takes output directory (CWD by default). Joins received `fileKey` with output dir using `path.join(outputDir, fileKey)`. Validates result is within `outputDir` (resolves and checks `startsWith`).

**Security:** Server MUST reject any `fileKey` that:
- Starts with `/`
- Contains `..`
- Contains `\`
- Resolves (via `path.resolve(outputDir, fileKey)`) to a path outside `outputDir`

### 4. Backpressure

Socket.IO acknowledgement callbacks provide natural backpressure:
1. Sender reads one chunk from disk
2. Sender emits `file-chunk` with ack callback
3. Sender **waits** for ack before reading/sending next chunk
4. Server writes chunk to `.part` file, then calls ack

This means: sender never buffers more than 1 chunk per concurrent file in memory. At 5 concurrency × 128KB = 640KB memory for chunk buffers. Acceptable.

### 5. Atomic Writes

1. Server writes incoming chunks to `<outputDir>/<fileKey>.part`
2. On `file-end` with checksum verified (or checksum disabled): `fsync` the fd, then `rename` `.part` → final path
3. On checksum mismatch: delete `.part` file, respond with error
4. On disconnect: `.part` file remains for future resume

### 6. Server Socket.IO Configuration

```js
const io = new Server(httpServer, {
  maxHttpBufferSize: 100_000_000,  // 100MB — accommodate large manifests
  pingTimeout: 120_000,            // 2 minutes — survive long resume queries
  pingInterval: 25_000,            // 25s — standard
  cors: { origin: '*' }            // LAN tool, no CORS restriction
});
```

---

## Interface Contracts

### `common/protocol.js`

```js
module.exports = {
  CHUNK_SIZE: 131072,              // 128KB
  EVENTS: {
    SESSION_INIT: 'session-init',
    FILE_START: 'file-start',
    FILE_CHUNK: 'file-chunk',
    FILE_END: 'file-end',
    TRANSFER_COMPLETE: 'transfer-complete',
    RESUME_QUERY: 'resume-query',
    RESUME_RESPONSE: 'resume-response'
  },
  DEFAULT_PORT: 8000,
  MAX_HTTP_BUFFER_SIZE: 100_000_000,
  PING_TIMEOUT: 120_000,
  PING_INTERVAL: 25_000
};
```

### `common/files.js`

```js
/**
 * @param {string} folder - Root folder to scan
 * @returns {Array<{relativePath: string, absolutePath: string, size: number, mtime: number}>}
 */
function listFiles(folder) { ... }

/**
 * Convert absolute path to POSIX-relative wire key.
 * @param {string} rootFolder - The folder being sent
 * @param {string} absolutePath - File's absolute path
 * @returns {string} - POSIX relative path (e.g., 'src/utils/helper.js')
 */
function toWireKey(rootFolder, absolutePath) { ... }

/**
 * Convert wire key to safe local path, validated against output directory.
 * @param {string} outputDir - Server's output directory
 * @param {string} wireKey - POSIX relative path from wire
 * @returns {string} - Absolute local path
 * @throws {Error} - If path escapes outputDir
 */
function fromWireKey(outputDir, wireKey) { ... }
```

### `common/concurrency.js`

```js
class ConcurrencyPool {
  /**
   * @param {number} limit - Max concurrent tasks
   * @param {object} [callbacks]
   * @param {function} [callbacks.onTaskComplete] - (result, taskIndex) => void
   * @param {function} [callbacks.onTaskError] - (error, taskIndex) => void
   */
  constructor(limit, callbacks = {}) { ... }

  /**
   * Run all tasks with per-task isolation. Never rejects.
   * @param {Array<() => Promise<any>>} tasks
   * @returns {Promise<{succeeded: any[], failed: Array<{index: number, error: Error}>}>}
   */
  async runAllSettled(tasks) { ... }

  /**
   * Run a single task when a slot is available.
   * @param {() => Promise<any>} taskFn
   * @returns {Promise<any>}
   */
  async run(taskFn) { ... }
}
```

### `client/connection.js`

```js
/**
 * @param {string} server - Hostname/IP
 * @param {number} port - Port number
 * @param {object} [options]
 * @param {number} [options.reconnectionAttempts] - Max reconnect tries (default: 10)
 * @param {number} [options.reconnectionDelay] - Base delay ms (default: 1000)
 * @returns {SocketIOClient.Socket}
 */
function createConnection(server, port, options = {}) { ... }

/**
 * Wait for socket to connect. Rejects after timeout.
 * @param {Socket} socket
 * @param {number} timeoutMs - default 30000
 * @returns {Promise<void>}
 */
function waitForConnect(socket, timeoutMs = 30000) { ... }

/**
 * Emit with ack and timeout.
 * @param {Socket} socket
 * @param {string} event
 * @param {any} payload
 * @param {number} timeoutMs
 * @returns {Promise<any>} - The ack response
 */
function emitWithAck(socket, event, payload, timeoutMs = 30000) { ... }
```

### `client/sender.js`

```js
/**
 * Send a single file using the chunked protocol.
 * @param {Socket} socket
 * @param {object} fileInfo - { absolutePath, relativePath (wireKey), size, mtime }
 * @param {object} options - { compress, checksum, chunkSize }
 * @param {object} [callbacks]
 * @param {function} [callbacks.onChunkSent] - (fileKey, chunkIndex, totalChunks, bytesSent) => void
 * @param {function} [callbacks.onFileComplete] - (fileKey, status) => void
 * @returns {Promise<{status: 'ok'|'checksum_mismatch'|'error', error?: Error}>}
 */
async function sendFile(socket, fileInfo, options, callbacks = {}) { ... }
```

### `server/receiver.js`

```js
/**
 * Register file transfer handlers on a socket.
 * @param {Socket} socket - Connected client socket
 * @param {string} outputDir - Base output directory
 * @param {object} sessionOptions - { compress, checksum }
 */
function registerFileHandlers(socket, outputDir, sessionOptions) { ... }
```

### `server/server.js`

```js
/**
 * Create and start the Socket.IO server.
 * @param {object} options
 * @param {number} options.port - Listen port
 * @param {string} options.outputDir - Base output directory (default: CWD)
 * @param {function} [options.onConnection] - (socket) => void
 * @returns {Promise<{io: Server, httpServer: HttpServer, close: () => Promise<void>}>}
 */
async function createServer(options) { ... }
```

---

## Acceptance Criteria

1. Transfer a single 1GB file → receiver has identical file (MD5 verified), sender memory < 200MB RSS
2. Transfer 10,000 × 1KB files → all arrive, no timeout, completes in < 60s on localhost
3. Kill client mid-transfer → only `.part` files exist on receiver, no corrupt final files
4. Send from Windows path `C:\Users\foo\docs\report.pdf` → receiver writes to `./docs/report.pdf`
5. Send fileKey `../../etc/passwd` → server rejects with error, connection stays alive
6. `npm ls socket.io-stream` → not found; `npm ls progress-stream` → not found
7. `remote-sync send --no-checksum` → no MD5 computation on either side, transfer completes
8. `remote-sync send --compress` → chunks are brotli-compressed independently, receiver decompresses per-chunk
9. Sender emits `file-chunk` and waits for ack before sending next chunk (backpressure verified by instrumentation)
10. Server started with `maxHttpBufferSize: 100MB`, `pingTimeout: 120s`, `pingInterval: 25s` (verified in tests)

---

## Constraints

- **DO NOT** introduce any new npm production dependencies
- **DO NOT** change the CLI command structure (`remote-sync send`, `remote-sync receive`)
- **DO NOT** remove the `--compress` or `--no-checksum` flags
- **DO NOT** use `socket.io-stream` in any form
- **DO NOT** use `progress-stream` — progress is handled in Phase 7
- **DO NOT** implement retry logic in this phase — that's Phase 6
- **DO NOT** implement resume (byte-offset) in this phase — that's Phase 5
- **DO** use Socket.IO acknowledgement callbacks (not separate response events) for all request-response patterns
- **DO** use `stream.pipeline()` or manual pipeline with proper error propagation for file reading
- **DO** validate all paths on the server side before any filesystem operation
- **DO** use `crypto.createHash('md5')` incrementally (update per chunk, digest at end)

---

## Dependencies

- None. This is Phase 4 — the first implementation phase.
- Assumes `socket.io@^4.8.3` and `socket.io-client@^4.8.3` remain (already in package.json).
- Assumes Node.js >= 18 (for stable `stream/promises`, `crypto.randomUUID()`).
