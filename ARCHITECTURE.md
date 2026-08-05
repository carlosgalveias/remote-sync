# Architecture

## System Overview

remote-sync is a two-process file transfer tool: a **sender** (client) reads a local folder and streams files over Socket.IO WebSockets to a **receiver** (server) that writes them atomically to disk. The protocol uses 128KB chunked binary transfer with per-chunk acknowledgements for backpressure, incremental MD5 verification, optional Brotli compression, and manifest-based resume from byte offsets.

## Protocol Specification

### Transport

- Socket.IO v4 over WebSocket (`ws://`)
- `maxHttpBufferSize`: 100 MB (allows chunks + overhead)
- `pingTimeout`: 120,000 ms
- `pingInterval`: 25,000 ms
- Client transport forced to `['websocket']` (no HTTP long-polling fallback)

### Event Names

Defined in `common/protocol.js`:

| Constant | Wire Name | Direction |
|----------|-----------|-----------|
| `SESSION_INIT` | `session-init` | Client → Server |
| `FILE_START` | `file-start` | Client → Server |
| `FILE_CHUNK` | `file-chunk` | Client → Server |
| `FILE_END` | `file-end` | Client → Server |
| `TRANSFER_COMPLETE` | `transfer-complete` | Client → Server |
| `RESUME_QUERY` | `resume-query` | Client → Server |
| `RESUME_RESPONSE` | `resume-response` | Server → Client |

All events use Socket.IO's acknowledgement callback pattern (emit + ack function).

### Protocol Flow

```
Sender                                    Receiver
  |                                          |
  |──── connect (WebSocket) ────────────────>|
  |                                          |
  |──── session-init ───────────────────────>|
  |<──── ack { ok: true } ──────────────────|
  |                                          |
  |  ┌─── per file (up to concurrency) ───┐ |
  |  │                                     │ |
  |  │── file-start ──────────────────────>│ |
  |  │<── ack { ok, offset } ─────────────│ |
  |  │                                     │ |
  |  │   (if offset === size → skip)       │ |
  |  │                                     │ |
  |  │── file-chunk ──────────────────────>│ |
  |  │<── ack { ok } ────────────────────-│ |
  |  │   ... repeat for each chunk ...     │ |
  |  │                                     │ |
  |  │── file-end ────────────────────────>│ |
  |  │<── ack { ok, status } ─────────────│ |
  |  │                                     │ |
  |  └────────────────────────────────────-┘ |
  |                                          |
  |──── transfer-complete ──────────────────>|
  |<──── ack { ok } ────────────────────────|
  |                                          |
  |──── disconnect ─────────────────────────>|
```

### Payload Formats

#### `session-init` (Client → Server)

```json
{
  "sessionId": "uuid-v4",
  "compress": false,
  "checksum": true,
  "resume": true
}
```

**Ack:** `{ "ok": true }`

#### `file-start` (Client → Server)

```json
{
  "fileKey": "src/utils/helper.js",
  "size": 4096,
  "mtime": 1704067200000,
  "compressed": false,
  "checksum": true,
  "resume": true
}
```

**Ack:** `{ "ok": true, "offset": 0 }`

- `offset === 0` → transfer from beginning
- `offset === size` → file already complete, skip it
- `0 < offset < size` → resume from that byte

#### `file-chunk` (Client → Server)

```json
{
  "fileKey": "src/utils/helper.js",
  "index": 0,
  "data": <Buffer>
}
```

`data` is a raw `Buffer` (binary). If compression enabled, `data` contains independently Brotli-compressed chunk data.

**Ack:** `{ "ok": true }`

On error: `{ "ok": false, "error": "message" }`

#### `file-end` (Client → Server)

```json
{
  "fileKey": "src/utils/helper.js",
  "md5": "d41d8cd98f00b204e9800998ecf8427e",
  "totalChunks": 1,
  "totalBytes": 4096
}
```

`md5` is `null` if checksums are disabled.

**Ack (success):** `{ "ok": true, "status": "verified" }`

**Ack (mismatch):** `{ "ok": false, "status": "checksum_mismatch", "expected": "...", "received": "..." }`

#### `transfer-complete` (Client → Server)

```json
{
  "sessionId": "uuid-v4",
  "totalFiles": 500,
  "totalBytes": 104857600,
  "skipped": 12
}
```

**Ack:** `{ "ok": true }`

## Module Responsibilities

### `index.js` — CLI Entry Point

Parses commands and options using Commander.js. Validates port numbers (1–65535), concurrency (1–100), and non-negative integers. Routes to `startReceiver()` or `runSendSession()`. Enforces mutual exclusivity of `--verbose` and `--quiet`.

### `client/index.js` — Send Orchestration

Top-level sender logic. Lists files, creates Socket.IO connection, initializes session, builds a concurrency pool of per-file tasks wrapped in retry logic, manages progress rendering, handles SIGINT and global timeout, emits `transfer-complete`, and determines exit code. Contains the `dryRun()` function that lists files without connecting.

### `client/connection.js` — Socket.IO Client Wrapper

Creates Socket.IO client with `ws://` transport. Provides `connectAndWait()` (connection with timeout), `emitWithAck()` (emit with ack timeout — default 30s), and `attachReconnectionHandlers()` for lifecycle events (disconnect, reconnect_attempt, reconnect, reconnect_failed).

### `client/sender.js` — Chunked File Sender

Implements `sendFile()`: emits `file-start`, reads file asynchronously in 128KB chunks, compresses per-chunk if enabled, hashes incrementally, emits `file-chunk` with backpressure (waits for ack), emits `file-end` with full-file MD5. Handles resume by fast-forwarding the hash through already-sent bytes from local disk.

### `client/progress.js` — Progress Renderer

Single-line progress bar with EWMA-smoothed throughput (α=0.3). Renders `[####    ] N/M files  X.X files/s  ETA HH:MM:SS`. Detects TTY vs non-TTY. Non-TTY emits plain lines every 5 seconds. Throttles redraws to 100ms. Handles above-bar warnings without corrupting display. Renders final summary line on completion.

### `client/resilience.js` — Retry & State Management

Contains:
- **Error classification** — `isRetriable()` checks against permanent codes (`EACCES`, `ENOENT`, `EISDIR`, `EPERM`, `ENAMETOOLONG`) and messages (path traversal)
- **`withRetry()`** — async retry wrapper with exponential backoff (base 1s, max 30s, jitter 500ms) and cancellable delays
- **`InFlightTracker`** — tracks files currently transferring, supports pause/resume on disconnect
- **`ConnectionStateMachine`** — states: `connecting` → `connected` → `transferring` → `reconnecting` → `dead`
- **`setupSigintHandler()`** — first Ctrl+C: pause pool + grace period (10s default); second: force quit; third: `process.exit(130)`
- **`writeFailureReport()`** — writes `failed-files.json` on partial failure

### `client/logger.js` — Log File Writer

Append-mode file writer with ISO timestamps. Four levels: error, warn, info, debug. Console output respects verbosity (quiet=error only, default=info, verbose=debug). Log file always writes at debug level. Integrates with progress renderer for above-bar output.

### `server/index.js` — Receiver Entry

Thin wrapper that resolves `outputDir` and delegates to `createServer()`.

### `server/server.js` — Socket.IO Server Factory

Creates HTTP server + Socket.IO instance. Handles `session-init` (sets session options, registers file handlers once per connection), `transfer-complete`, and `disconnect`. Displays local network IPs on startup. Calls `initReceiverResume()` on startup to reconcile manifest.

### `server/receiver.js` — Chunk Assembly & Atomic Writes

Registers per-socket event handlers for `file-start`, `file-chunk`, `file-end`. Manages per-file state (fd, hash, partPath, finalPath, bytesWritten). Decompresses chunks if compressed. Writes to `.part` file at tracked position. On `file-end`: verifies MD5, fsync, rename to final path. On disconnect: fsync all active `.part` files and flush manifest.

### `server/manifest.js` — Persistent Resume Manifest

In-memory cached manifest with atomic disk persistence (write to `.tmp` → fsync → rename). Tracks per-file state: `{ expectedSize, bytesWritten, status, lastModified, expectedChecksum }`. Key functions:
- `determineOffset()` — resume decision logic
- `markComplete()` — always flushes to disk
- `registerPartial()` — flushes every 10 calls (batched I/O)
- `reconcile()` — startup cleanup of stale `.part` files
- `flushManifest()` — force flush on disconnect

### `common/protocol.js` — Shared Constants

Defines `CHUNK_SIZE` (131072 bytes = 128KB), `EVENTS` map, `DEFAULT_PORT` (8000), `MAX_HTTP_BUFFER_SIZE` (100MB), `PING_TIMEOUT` (120s), `PING_INTERVAL` (25s).

### `common/files.js` — Directory Scanner & Path Safety

`listFiles()` — recursive synchronous directory walk. Returns `{ relativePath, absolutePath, size, mtime }`. Skips `.remote-sync` at any nesting level.

`toWireKey()` — converts absolute path to POSIX-relative wire key. Rejects `..` and leading `/`.

`fromWireKey()` — converts wire key to local path. Rejects `..`, leading `/`, and backslashes. Verifies resolved path stays within output directory.

### `common/compression.js` — Brotli Utilities

Exports `DEFAULT_BROTLI_OPTIONS` with quality 3 (speed-optimized). Provides `createCompressStream()` and `createDecompressStream()` factory functions. Sender uses `promisify(zlib.brotliCompress)` with these options for per-chunk async compression.

### `common/concurrency.js` — ConcurrencyPool

Manages parallel task execution with configurable slot count. Provides `runAllSettled()` (returns succeeded/failed arrays), `pause()`, `resume()`. Per-task isolation ensures one failure doesn't affect others.

## Resume Algorithm

```
determineOffset(outputDir, wireKey, expectedSize, expectedChecksum, resume):
│
├─ resume === false?
│   └─ return 0 (always overwrite)
│
├─ manifest has entry with status === 'complete'?
│   ├─ entry.expectedSize === expectedSize?
│   │   ├─ checksums both available and match?
│   │   │   ├─ final file exists on disk with correct size?
│   │   │   │   └─ return expectedSize (SKIP)
│   │   │   └─ file missing → return 0
│   │   ├─ no checksum comparison → file exists with correct size?
│   │   │   └─ return expectedSize (SKIP) or 0
│   │   └─ size mismatch → return 0
│   └─ size mismatch → return 0
│
├─ manifest has entry with status === 'partial' AND expectedSize matches?
│   ├─ .part file exists on disk?
│   │   ├─ partSize > 0 AND partSize < expectedSize?
│   │   │   └─ return floor(partSize / CHUNK_SIZE) * CHUNK_SIZE (chunk-aligned)
│   │   └─ partSize >= expectedSize → return 0 (corrupted)
│   └─ .part file missing → return 0
│
└─ default: return 0 (fresh transfer)
```

## Resilience Model

### Connection State Machine

```
                    ┌──────────────────┐
          connect   │                  │  session-init ack
     ┌─────────────>│   CONNECTED      │──────────────────┐
     │              │                  │                   │
     │              └────────┬─────────┘                   v
     │                       │                    ┌──────────────────┐
     │              transfer │                    │                  │
     │              starts   │                    │  TRANSFERRING    │
     │                       │                    │                  │
     │                       v                    └────────┬─────────┘
┌────┴─────┐                                              │
│           │         disconnect                          │ disconnect
│ CONNECTING│<───────────────────┐                        │
│           │                    │                        │
└───────────┘                    │                        v
                         ┌───────┴──────────┐
                         │                  │   attempts > 10
                         │  RECONNECTING    │────────────────────┐
                         │                  │                    │
                         └──────────────────┘                    v
                                                      ┌──────────────────┐
                                                      │                  │
                                                      │      DEAD        │
                                                      │                  │
                                                      └──────────────────┘
```

### Retry Policy

- **Max attempts** = `retries + 1` (default 4 total: 1 initial + 3 retries)
- **Backoff**: `min(1000 * 2^attempt + random(0, 500), 30000)` ms
- **Non-retryable errors** abort immediately (no backoff)
- **Abort conditions**: SIGINT in progress, global timeout reached

### SIGINT Handling

1. **First Ctrl+C**: Pause pool (no new tasks start). Grace period (10s) for in-flight to finish. If all drain → clean exit.
2. **Second Ctrl+C**: Force quit. Write failure report with in-flight snapshot.
3. **Third+ Ctrl+C**: `process.exit(130)`.

### Reconnection

- Socket.IO built-in reconnection: 10 attempts, 1s base delay, 30s max delay
- On reconnect: re-emit `session-init` to re-register handlers
- In-flight files are paused on disconnect, resumed on reconnect
- If all 10 attempts fail → state machine transitions to DEAD → exit code 2

## Data Flow Diagrams

### Sender Pipeline (per file)

```
┌──────────────┐     ┌──────────────┐     ┌────────────────┐
│ Open file    │────>│ Read 128KB   │────>│ Hash chunk     │
│ (async)      │     │ (async I/O)  │     │ (MD5 update)   │
└──────────────┘     └──────────────┘     └───────┬────────┘
                                                   │
                          ┌────────────────────────┘
                          v
                   ┌────────────────┐     ┌────────────────┐
                   │ Compress chunk │────>│ Emit chunk     │
                   │ (Brotli, opt)  │     │ + wait ack     │
                   └────────────────┘     └───────┬────────┘
                                                   │
                          ┌────────────────────────┘
                          v
                   ┌────────────────┐
                   │ More chunks?   │──── yes ──> loop back to Read
                   └───────┬────────┘
                           │ no
                           v
                   ┌────────────────┐     ┌────────────────┐
                   │ Finalize MD5   │────>│ Emit file-end  │
                   │ hash.digest()  │     │ + wait ack     │
                   └────────────────┘     └────────────────┘
```

### Receiver Pipeline (per file)

```
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│ file-start     │────>│ Determine      │────>│ Open .part     │
│ received       │     │ resume offset  │     │ (create/append)│
└────────────────┘     └────────────────┘     └───────┬────────┘
                                                       │
                          ┌────────────────────────────┘
                          v
                   ┌────────────────┐     ┌────────────────┐
                   │ file-chunk     │────>│ Decompress     │
                   │ received       │     │ (if compressed)│
                   └────────────────┘     └───────┬────────┘
                                                   │
                          ┌────────────────────────┘
                          v
                   ┌────────────────┐     ┌────────────────┐
                   │ Hash chunk     │────>│ Write to .part │
                   │ (MD5 update)   │     │ at position    │
                   └────────────────┘     └───────┬────────┘
                                                   │
                          ┌────────────────────────┘
                          v
                   ┌────────────────┐
                   │ file-end       │
                   │ received       │
                   └───────┬────────┘
                           │
                           v
                   ┌────────────────┐     ┌────────────────┐
                   │ Verify MD5     │────>│ fsync + rename │
                   │ (if enabled)   │     │ .part → final  │
                   └────────────────┘     └───────┬────────┘
                                                   │
                                                   v
                                          ┌────────────────┐
                                          │ Mark complete  │
                                          │ in manifest    │
                                          └────────────────┘
```

## Configuration

### Server (Receiver) Options

| Parameter | Source | Default | Notes |
|-----------|--------|---------|-------|
| `port` | CLI `-p` | `8000` | `DEFAULT_PORT` from protocol.js |
| `outputDir` | CLI `-o` | `process.cwd()` | Resolved to absolute path |
| `verbose` | CLI `-v` | `false` | |
| `quiet` | CLI `-q` | `false` | Mutually exclusive with verbose |
| `logFile` | CLI `--log-file` | `null` | |
| `maxHttpBufferSize` | Hardcoded | 100 MB | In protocol.js |
| `pingTimeout` | Hardcoded | 120,000 ms | In protocol.js |
| `pingInterval` | Hardcoded | 25,000 ms | In protocol.js |

### Client (Sender) Options

| Parameter | Source | Default | Notes |
|-----------|--------|---------|-------|
| `address` | CLI `-a` | `127.0.0.1` | |
| `port` | CLI `-p` | `8000` | |
| `folder` | CLI `-f` | `process.cwd()` | Resolved to absolute path |
| `concurrency` | CLI `-c` | `5` | Range: 1–100 |
| `compress` | CLI `-z` | `false` | Brotli quality 3 |
| `checksum` | CLI `--no-checksum` | `true` | MD5 full-file verification |
| `retries` | CLI `-r` | `3` | Total attempts = retries + 1 |
| `resume` | CLI `--no-resume` | `true` | |
| `timeout` | CLI `--timeout` | `30000` ms | Per-chunk ack timeout |
| `globalTimeout` | CLI `--global-timeout` | `0` | 0 = no limit |
| `dryRun` | CLI `--dry-run` | `false` | No network connection |
| `verbose` | CLI `-v` | `false` | |
| `quiet` | CLI `-q` | `false` | |
| `logFile` | CLI `--log-file` | `null` | |
| `stallTimeout` | Internal | `30000` ms | Same as chunk timeout |
| `graceTimeout` | Internal | `10000` ms | SIGINT grace period |
| `reconnectionAttempts` | Hardcoded | `10` | Socket.IO reconnect attempts |
| `reconnectionDelay` | Hardcoded | `1000` ms | Base reconnect delay |
| `reconnectionDelayMax` | Hardcoded | `30000` ms | Max reconnect delay |

## File Formats

### `manifest.json`

Location: `<outputDir>/.remote-sync/manifest.json`

```json
{
  "files": {
    "src/utils/helper.js": {
      "expectedSize": 4096,
      "expectedChecksum": "d41d8cd98f00b204e9800998ecf8427e",
      "bytesWritten": 4096,
      "lastModified": "2025-01-15T10:30:00.000Z",
      "status": "complete"
    },
    "src/index.js": {
      "expectedSize": 131072,
      "expectedChecksum": "abc123...",
      "bytesWritten": 65536,
      "lastModified": "2025-01-15T10:30:05.000Z",
      "status": "partial"
    }
  }
}
```

**Fields per entry:**

| Field | Type | Description |
|-------|------|-------------|
| `expectedSize` | number | Total file size declared by sender |
| `expectedChecksum` | string \| undefined | Full-file MD5 (omitted if checksums disabled) |
| `bytesWritten` | number | Bytes successfully written to disk |
| `lastModified` | string | ISO 8601 timestamp of last activity |
| `status` | `"partial"` \| `"complete"` | Transfer state |

**Persistence:**
- `markComplete()` always flushes immediately
- `registerPartial()` flushes every 10 calls (batched for I/O performance)
- `flushManifest()` called on disconnect (ensures all progress saved)
- Atomic write: data → `.manifest.json.tmp` → fsync → rename to `manifest.json`

### `failed-files.json`

Location: sender's working directory (written on exit code 1)

```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "totalFiles": 500,
  "succeeded": 497,
  "failed": 3,
  "failures": [
    {
      "file": "src/broken.js",
      "wireKey": "src/broken.js",
      "error": "Timeout waiting for ack on 'file-chunk' after 30000ms",
      "attempts": 4
    }
  ]
}
```

## Security Considerations

**This tool provides no security.** It is designed for trusted LAN environments only.

- **No encryption** — all data travels as plaintext WebSocket frames
- **No authentication** — any client can connect to a receiver
- **No authorization** — any connected client can write any file within `outputDir`
- **Path traversal protection** — the only security measure: `fromWireKey()` rejects `..`, absolute paths, backslashes, and verifies resolved paths stay within `outputDir`
- **No rate limiting** — a malicious client could fill disk
- **No TLS** — vulnerable to MITM on untrusted networks

**Do not expose the receiver port to the internet.** Use only on trusted local networks, behind firewalls.
