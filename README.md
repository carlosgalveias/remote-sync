# remote-sync

Fast LAN file transfer CLI with chunked binary protocol, resume capability, and integrity verification. Copies a folder recursively from one machine to another over a local network using Socket.IO v4 WebSockets.

## Installation

```bash
# Clone and install
git clone <repo-url>
cd remote-sync
npm install

# Link globally (optional)
npm link
```

**Requires Node.js >= 18.0.0**

## Quick Start

On the **receiving** machine:

```bash
remote-sync receive -p 8000 -o ./incoming
```

On the **sending** machine:

```bash
remote-sync send -a 192.168.1.50 -p 8000 -f ./my-project
```

## CLI Reference

### `remote-sync receive`

Starts the receiver server, waiting for incoming file transfers.

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <number>` | Port to listen on | `8000` |
| `-o, --output <dir>` | Output directory for received files | Current working directory |
| `-v, --verbose` | Verbose output | Off |
| `-q, --quiet` | Quiet output (errors only) | Off |
| `--log-file <path>` | Write all output to a log file | None |

`--verbose` and `--quiet` are mutually exclusive.

### `remote-sync send`

Sends a folder recursively to a running receiver.

| Option | Description | Default |
|--------|-------------|---------|
| `-a, --address <ip>` | IP address of the receiver | `127.0.0.1` |
| `-p, --port <number>` | Port of the receiver | `8000` |
| `-f, --folder <folder>` | Folder to send | Current working directory |
| `-c, --concurrency <number>` | Number of parallel file transfers (1–100) | `5` |
| `-z, --compress` | Enable per-chunk Brotli compression | Off |
| `--no-checksum` | Disable MD5 checksum verification | Checksum enabled |
| `-r, --retries <number>` | Max retries per file | `3` |
| `--no-resume` | Disable resume (transfer everything from scratch) | Resume enabled |
| `--timeout <ms>` | Per-chunk ack timeout in milliseconds | `30000` |
| `--global-timeout <ms>` | Total transfer timeout (0 = no limit) | `0` |
| `--dry-run` | List files that would be transferred, then exit | Off |
| `-v, --verbose` | Show per-file events | Off |
| `-q, --quiet` | Suppress progress bar, show only final summary + errors | Off |
| `--log-file <path>` | Write detailed transfer log to file | None |

`--verbose` and `--quiet` are mutually exclusive.

## Features

- **Chunked binary protocol** — 128KB chunks over Socket.IO v4 WebSockets
- **Ack-based backpressure** — each chunk waits for receiver acknowledgement
- **Incremental MD5 verification** — computed during transfer, no separate hash pass
- **Per-chunk Brotli compression** — quality 3, independent per chunk (opt-in with `-z`)
- **Atomic writes** — receiver writes to `.part` file, fsync, then rename to final path
- **Byte-offset resume** — `.part` files resume from chunk-aligned offset
- **Persistent manifest** — tracks transfer state in `<outputDir>/.remote-sync/manifest.json`
- **Per-file retry** — exponential backoff with jitter (base 1s, cap 30s, jitter 500ms)
- **Concurrency pool** — parallel transfers with per-task isolation
- **Connection resilience** — Socket.IO reconnection (10 attempts, 1s–30s backoff)
- **SIGINT handling** — first signal: graceful (finish in-flight), second: force quit
- **Single-line progress bar** — EWMA-smoothed speed and ETA
- **Non-TTY fallback** — periodic plain lines every 5 seconds, no ANSI codes
- **Dry-run mode** — list files without transferring (no network connection)
- **Log file** — timestamped append-mode event log
- **`failed-files.json`** — written on partial failure for retry automation
- **Cross-platform paths** — POSIX keys on wire, native paths on disk
- **Path safety** — rejects `..`, absolute paths, and backslash injection

## Resume Behavior

Resume is enabled by default. The receiver maintains state in:

```
<outputDir>/.remote-sync/manifest.json
```

**How it works:**

1. Sender emits `file-start` with file size (and checksum if enabled)
2. Receiver checks manifest + filesystem to determine resume offset
3. If file is already complete (size and checksum match) → offset equals file size → **skip**
4. If `.part` file exists with valid partial data → offset is **chunk-aligned** (floor to 128KB boundary)
5. Otherwise → offset is `0` (fresh transfer)

**On resume from offset > 0:**
- Sender fast-forwards its MD5 hash through bytes `[0, offset)` from local disk
- Receiver fast-forwards its MD5 hash through bytes `[0, offset)` from the `.part` file
- Both then continue hashing from `offset` onward, ensuring full-file checksum coverage

**On disconnect:**
- Receiver fsyncs and closes all active `.part` files
- Manifest is flushed to disk with current `bytesWritten` values
- On next connection, `.part` files resume from their last chunk-aligned position

**On startup:**
- Receiver reconciles manifest with filesystem
- Stale `.part` files without manifest entries are deleted

The `.remote-sync` directory is automatically excluded from file listings.

## Progress Display

**TTY mode** (interactive terminal):

```
[#####################               ] 1234/5678 files  12.4 files/s  ETA 00:05:57
```

With failures:

```
[#####################               ] 1234/5678 files  12.4 files/s  ETA 00:05:57  failed:3
```

Redraws throttled to every 100ms. Speed uses EWMA smoothing (α=0.3).

**Non-TTY mode** (piped/CI):

Periodic plain-text lines every 5 seconds, no `\r` or ANSI escape codes.

**Final summary:**

```
✓ Transfer complete: 500 transferred, 12 skipped, 0 failed | 1.2 GB | 00:02:15 | 3.8 files/s
```

## Error Handling & Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| `0` | All files transferred successfully |
| `1` | Partial failure (some files failed after all retries) |
| `2` | Fatal error (connection failed, all reconnects exhausted) |

**Error classification:**

- **Non-retryable** (fail immediately): `EACCES`, `ENOENT`, `EISDIR`, `EPERM`, `ENAMETOOLONG`, path traversal attempts
- **Retryable** (exponential backoff): timeout, checksum mismatch, connection errors, server busy

**On partial failure**, a `failed-files.json` is written to the sender's working directory:

```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "totalFiles": 500,
  "succeeded": 497,
  "failed": 3,
  "failures": [
    {
      "file": "path/to/file.txt",
      "wireKey": "path/to/file.txt",
      "error": "Timeout waiting for ack on 'file-chunk' after 30000ms",
      "attempts": 4
    }
  ]
}
```

## Known Limitations

- No encryption or authentication — designed for trusted LAN only
- No file deletion sync — only copies, never deletes on receiver
- No symlink support — symlinks are not followed or transferred
- No file permission/mode preservation
- Port must be manually configured on both sides
- Resume only works with the same receiver output directory
- No bandwidth throttling
- Large files resume at chunk boundaries only (128KB granularity)
- Single sender per receiver session (no multi-client)

## Development

### Testing

```bash
# Run all tests with coverage
npm test

# Unit tests only
npm run test:unit

# Integration tests (fault injection)
npm run test:integration

# Watch mode
npm run test:watch
```

### Linting

```bash
npm run lint
npm run lint:fix
```

Uses ESLint 9 with flat config (`eslint.config.js`).

## Project Structure

```
remote-sync/
├── index.js              # CLI entry point (Commander.js)
├── eslint.config.js      # ESLint 9 flat config
├── package.json
├── client/
│   ├── index.js          # Send orchestration (runSendSession)
│   ├── connection.js     # Socket.IO client wrapper + reconnection
│   ├── sender.js         # Chunked file sender (sendFile)
│   ├── progress.js       # Single-line progress renderer
│   ├── resilience.js     # Retry, state machine, SIGINT, failure report
│   └── logger.js         # Append-mode log file writer
├── server/
│   ├── index.js          # Receiver entry (startReceiver)
│   ├── server.js         # Socket.IO server factory
│   ├── receiver.js       # Chunk assembly, atomic writes, checksum verify
│   └── manifest.js       # Persistent resume manifest (read/write/reconcile)
├── common/
│   ├── protocol.js       # Shared constants (CHUNK_SIZE, EVENTS, ports)
│   ├── files.js          # Recursive directory scanner + path safety
│   ├── checksum.js       # MD5 hash utilities
│   ├── compression.js    # Brotli compress/decompress (quality 3)
│   └── concurrency.js    # ConcurrencyPool
└── tests/
    ├── client/           # Unit tests
    ├── server/           # Unit tests
    ├── common/           # Unit tests
    └── integration/      # Fault-injection tests
```

## Dependencies

### Runtime
- `commander` ^15.0.0 — CLI argument parsing
- `socket.io` ^4.8.3 — WebSocket server
- `socket.io-client` ^4.8.3 — WebSocket client

### Development
- `jest` ^30.4.2 — test framework
- `@jest/globals` ^30.4.1 — Jest ESM globals
- `eslint` ^9.0.0 — linter
- `@eslint/js` ^9.0.0 — ESLint recommended rules

## License

ISC
