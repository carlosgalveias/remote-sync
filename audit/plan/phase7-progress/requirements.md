# Phase 7 — Single-line Progress Renderer: Requirements

## Scope

Create an isolated, unit-testable progress display module that renders a single self-updating terminal line showing transfer progress. Zero coupling to transfer logic — receives events, renders output.

---

## Files to Create

| File | Purpose |
|------|---------|
| `client/progress.js` | `ProgressRenderer` class — the entire module |

## Files to Modify

| File | Change |
|------|--------|
| `client/index.js` | Wire pool/sender callbacks to the renderer instance |

---

## Design Decisions

### 1. Event-Driven, Zero Coupling

The progress renderer knows NOTHING about sockets, files, or protocols. It receives structured events and renders output. This makes it trivially testable with mock data.

**Events it consumes:**
- `fileStart(wireKey, size)` — a file transfer began
- `fileProgress(wireKey, bytesSent, totalBytes)` — bytes confirmed for a file
- `fileComplete(wireKey)` — a file finished successfully
- `fileError(wireKey, errorMessage)` — a file failed
- `warn(message)` — a warning to display (above progress line)
- `finish(stats)` — transfer session ended

### 2. Output Format

**TTY mode (interactive terminal):**
```
[████████████░░░░░░░░] 847/2,103 files | 12.4 MB/s | ETA 3m 22s
```

Components:
- ASCII progress bar: 20 chars wide, `█` for filled, `░` for empty
- File counter: `completed/total`
- Transfer speed: EWMA-smoothed, human-readable (KB/s, MB/s, GB/s)
- ETA: based on EWMA speed and remaining bytes

**Non-TTY mode (piped output):**
```
[done] src/index.js (4.1 KB)
[done] assets/logo.png (1.0 MB)
[fail] docs/broken.pdf — CHECKSUM_MISMATCH
```

One line per completed/failed file. No ANSI escapes. No progress bar.

### 3. Speed Calculation — EWMA

Exponentially Weighted Moving Average with α=0.3:

```js
// On each progress update:
const elapsed = now - lastSampleTime;
if (elapsed >= sampleInterval) {  // sample every 500ms
  const instantSpeed = bytesSinceLastSample / (elapsed / 1000);  // bytes/sec
  ewmaSpeed = alpha * instantSpeed + (1 - alpha) * ewmaSpeed;
  lastSampleTime = now;
  bytesSinceLastSample = 0;
}
```

**Why EWMA over simple average?**
- Simple average is dominated by initial burst/slow start
- EWMA weights recent samples more heavily
- α=0.3 gives ~3 sample memory (responds quickly to speed changes but doesn't jitter)

### 4. ETA Calculation

```js
function calculateETA(remainingBytes, ewmaSpeed) {
  if (ewmaSpeed <= 0) return 'calculating...';
  const seconds = remainingBytes / ewmaSpeed;
  if (seconds > 86400) return '> 1 day';
  if (seconds > 3600) return `${Math.floor(seconds/3600)}h ${Math.floor((seconds%3600)/60)}m`;
  if (seconds > 60) return `${Math.floor(seconds/60)}m ${Math.floor(seconds%60)}s`;
  return `${Math.floor(seconds)}s`;
}
```

### 5. Throttled Redraws

Redraws capped at 10/s (100ms minimum interval). Reason: faster updates cause terminal flicker and waste CPU on ANSI escape processing.

```js
render() {
  const now = Date.now();
  if (now - this._lastRender < 100) return;  // throttle
  this._lastRender = now;
  // ... actual render
}
```

### 6. Warning/Error Messages Above Progress Line

When a warning or error needs to display, the progress line is cleared, the message is printed, then the progress line is re-rendered below:

```js
warn(message) {
  if (this._isTTY) {
    this._stream.write('\r' + ' '.repeat(this._lineWidth) + '\r');  // clear line
    this._stream.write(`[warn] ${message}\n`);
    this._renderLine();  // re-draw progress below
  } else {
    this._stream.write(`[warn] ${message}\n`);
  }
}
```

---

## Interface Contracts

### `client/progress.js`

```js
class ProgressRenderer {
  /**
   * @param {object} options
   * @param {NodeJS.WritableStream} [options.stream] - Output stream (default: process.stdout)
   * @param {boolean} [options.isTTY] - Override TTY detection (for testing)
   * @param {number} [options.totalFiles] - Total number of files to transfer
   * @param {number} [options.totalBytes] - Total bytes to transfer
   * @param {number} [options.barWidth] - Progress bar character width (default: 20)
   * @param {number} [options.throttleMs] - Min ms between redraws (default: 100)
   * @param {number} [options.ewmaAlpha] - EWMA smoothing factor (default: 0.3)
   */
  constructor(options = {}) { ... }

  /**
   * Notify that a file transfer has started.
   * @param {string} wireKey - File identifier
   * @param {number} size - File size in bytes
   */
  fileStart(wireKey, size) { ... }

  /**
   * Notify of byte progress for a file.
   * @param {string} wireKey
   * @param {number} bytesSent - Total bytes sent for this file so far
   * @param {number} totalBytes - Total size of this file
   */
  fileProgress(wireKey, bytesSent, totalBytes) { ... }

  /**
   * Notify that a file completed successfully.
   * @param {string} wireKey
   */
  fileComplete(wireKey) { ... }

  /**
   * Notify that a file failed.
   * @param {string} wireKey
   * @param {string} errorMessage
   */
  fileError(wireKey, errorMessage) { ... }

  /**
   * Display a warning message (printed above progress line in TTY mode).
   * @param {string} message
   */
  warn(message) { ... }

  /**
   * Signal transfer session is complete. Renders final summary line.
   * @param {object} stats - { succeeded: number, failed: number, totalBytes: number, elapsed: number }
   */
  finish(stats) { ... }

  /**
   * Force a render (ignores throttle). Used before exit.
   */
  flush() { ... }
}
```

### Integration Point (in `client/index.js`)

```js
// Setup:
const progress = new ProgressRenderer({
  totalFiles: filesToSend.length,
  totalBytes: filesToSend.reduce((sum, f) => sum + f.size, 0)
});

// Wire to sender callbacks:
const callbacks = {
  onChunkSent: (wireKey, chunkIndex, totalChunks, bytesSent) => {
    progress.fileProgress(wireKey, bytesSent, fileInfo.size);
  },
  onFileComplete: (wireKey, status) => {
    if (status === 'ok' || status === 'verified') {
      progress.fileComplete(wireKey);
    } else {
      progress.fileError(wireKey, status);
    }
  }
};

// Wire to pool callbacks:
const poolCallbacks = {
  onTaskError: (err, index) => {
    progress.fileError(filesToSend[index].wireKey, err.message);
  }
};

// On transfer complete:
progress.finish({
  succeeded: result.succeeded.length,
  failed: result.failed.length,
  totalBytes: totalBytesSent,
  elapsed: Date.now() - startTime
});
```

---

## Acceptance Criteria

1. Single self-updating line in TTY mode: `[████████░░░░░░░░░░░░] 847/2,103 files | 12.4 MB/s | ETA 3m 22s`
2. Non-TTY mode: one line per completed/failed file, no ANSI escape sequences
3. Redraws max 10/s (verified: successive `fileProgress` calls within 100ms produce only one render)
4. Warning messages appear ABOVE the progress line (progress line is preserved/re-rendered)
5. Unit-testable: construct with `{ stream: mockWritable, isTTY: true }`, verify output written to mock
6. Speed uses EWMA (α=0.3): feed 10 samples of 1MB/s then 5 samples of 2MB/s → speed converges toward 2MB/s, not average of all samples
7. ETA format: `"3m 22s"` not `"202s"` or `"0.056h"`
8. Progress bar correctly represents `completedBytes / totalBytes` (not file count)
9. `finish()` clears the progress line and prints final summary: `"✓ 2,103 files (1.5 GB) in 2m 14s — average 11.5 MB/s"`
10. Module has zero `require` calls to any other project module (fully isolated)

---

## Constraints

- **DO NOT** import Socket.IO, sender, pool, or any transfer module
- **DO NOT** use `progress-stream` or any npm dependency
- **DO NOT** use `readline` module (too heavy for one line)
- **DO NOT** assume `process.stdout` — always use the injected `stream`
- **DO NOT** write progress to stderr (it goes to stdout; errors go to stderr)
- **DO** handle terminal width (use `stream.columns || 80`)
- **DO** handle the case where `totalFiles` or `totalBytes` is updated mid-transfer (files added from retry queue)
- **DO** export the class as the module's default export

---

## Dependencies

- **Phase 4 complete:** Needs the `onChunkSent` / `onFileComplete` callback interface from `sender.js`.
- **No dependency on Phase 5 or 6** — can be developed in parallel once Phase 4's callback interface is defined.
