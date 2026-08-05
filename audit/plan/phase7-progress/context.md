# Phase 7 — Single-line Progress Renderer: Context

## Current Progress Implementation (Being Replaced)

The current progress display uses the `progress-stream` npm package and writes directly to `process.stdout` with ANSI escape sequences that crash in non-TTY environments.

### Current Code (`client/index.js` lines 83-94)

```js
const progressStream = progress({
  length: fileSize,
  time: 500 /* ms */
});

progressStream.on('progress', (p) => {
  process.stdout.clearLine();      // ← crashes if not TTY
  process.stdout.cursorTo(0);      // ← crashes if not TTY
  process.stdout.write(
    `[progress] ${filePath} — ${Math.round(p.percentage)}% | ETA: ${p.eta}s`
  );
});
```

**Problems (ADD-002):**
1. `process.stdout.clearLine()` is `undefined` when stdout is not a TTY (piped to file, CI environment)
2. Shows per-file progress, not aggregate transfer progress
3. No speed display (only percentage and ETA from `progress-stream`)
4. With 5 concurrent files, the lines overlap/corrupt each other
5. Absolute file paths shown to user (noisy, unhelpful)

---

## New Progress Module — Complete Design

### Architecture

```
┌──────────────────────────────────────────────┐
│              ProgressRenderer                 │
│                                              │
│  Inputs (method calls):                      │
│    fileStart(wireKey, size)                   │
│    fileProgress(wireKey, bytesSent, total)    │
│    fileComplete(wireKey)                      │
│    fileError(wireKey, msg)                    │
│    warn(message)                             │
│    finish(stats)                             │
│                                              │
│  Internal State:                             │
│    - completedFiles: number                  │
│    - totalFiles: number                      │
│    - completedBytes: number                  │
│    - totalBytes: number                      │
│    - ewmaSpeed: number (bytes/sec)           │
│    - activeFiles: Map<wireKey, bytesSent>    │
│    - lastRenderTime: number                  │
│    - lastSampleTime: number                  │
│    - bytesSinceLastSample: number            │
│                                              │
│  Output (writes to stream):                  │
│    - TTY: single overwritten line            │
│    - Non-TTY: one line per event             │
└──────────────────────────────────────────────┘
```

### Rendering Algorithm (TTY Mode)

```js
_renderLine() {
  const now = Date.now();
  if (now - this._lastRender < this._throttleMs) return;
  this._lastRender = now;

  // Calculate progress
  const activeBytes = [...this._activeFiles.values()].reduce((s, b) => s + b, 0);
  const currentBytes = this._completedBytes + activeBytes;
  const fraction = this._totalBytes > 0 ? currentBytes / this._totalBytes : 0;

  // Build bar
  const filled = Math.round(fraction * this._barWidth);
  const empty = this._barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  // Format numbers
  const filesStr = `${this._completedFiles.toLocaleString()}/${this._totalFiles.toLocaleString()} files`;
  const speedStr = this._formatSpeed(this._ewmaSpeed);
  const etaStr = this._calculateETA(this._totalBytes - currentBytes);

  // Compose line
  const line = `[${bar}] ${filesStr} | ${speedStr} | ETA ${etaStr}`;

  // Write (overwrite current line)
  this._stream.write(`\r${line}${''.padEnd(Math.max(0, this._lastLineLength - line.length))}`);
  this._lastLineLength = line.length;
}
```

### Speed Formatting

```js
_formatSpeed(bytesPerSec) {
  if (bytesPerSec <= 0) return '-- B/s';
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  if (bytesPerSec < 1073741824) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1073741824).toFixed(2)} GB/s`;
}
```

### EWMA Speed Calculation

```js
_updateSpeed(bytesJustConfirmed) {
  this._bytesSinceLastSample += bytesJustConfirmed;
  const now = Date.now();
  const elapsed = now - this._lastSampleTime;

  if (elapsed >= 500) {  // Sample every 500ms
    const instantSpeed = this._bytesSinceLastSample / (elapsed / 1000);

    if (this._ewmaSpeed === 0) {
      // First sample — use as initial value
      this._ewmaSpeed = instantSpeed;
    } else {
      this._ewmaSpeed = this._alpha * instantSpeed + (1 - this._alpha) * this._ewmaSpeed;
    }

    this._bytesSinceLastSample = 0;
    this._lastSampleTime = now;
  }
}
```

### Non-TTY Mode

```js
// In fileComplete:
if (!this._isTTY) {
  this._stream.write(`[done] ${wireKey} (${this._formatSize(size)})\n`);
}

// In fileError:
if (!this._isTTY) {
  this._stream.write(`[fail] ${wireKey} — ${errorMessage}\n`);
}

// In finish:
const summary = `✓ ${stats.succeeded.toLocaleString()} files` +
  ` (${this._formatSize(stats.totalBytes)})` +
  ` in ${this._formatDuration(stats.elapsed)}` +
  ` — average ${this._formatSpeed(stats.totalBytes / (stats.elapsed / 1000))}`;
this._stream.write(summary + '\n');

if (stats.failed > 0) {
  this._stream.write(`✗ ${stats.failed} file(s) failed\n`);
}
```

### Size Formatting

```js
_formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
```

### Duration Formatting

```js
_formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
```

---

## Test Strategy

Since this module is fully isolated, it can be tested with a mock writable stream:

```js
const { ProgressRenderer } = require('../../client/progress');

function createMockStream() {
  const chunks = [];
  return {
    write(data) { chunks.push(data); return true; },
    columns: 120,
    getOutput() { return chunks.join(''); },
    getLines() { return chunks; },
    clearLine() {},
    cursorTo() {}
  };
}

describe('ProgressRenderer', () => {
  test('renders progress bar in TTY mode', () => {
    const stream = createMockStream();
    const renderer = new ProgressRenderer({
      stream,
      isTTY: true,
      totalFiles: 10,
      totalBytes: 10240
    });

    renderer.fileStart('a.txt', 1024);
    renderer.fileProgress('a.txt', 512, 1024);
    renderer.flush();  // Force render

    const output = stream.getOutput();
    expect(output).toContain('█');
    expect(output).toContain('0/10 files');
  });

  test('non-TTY mode prints one line per file', () => {
    const stream = createMockStream();
    const renderer = new ProgressRenderer({
      stream,
      isTTY: false,
      totalFiles: 2,
      totalBytes: 2048
    });

    renderer.fileStart('a.txt', 1024);
    renderer.fileComplete('a.txt');

    const lines = stream.getLines();
    expect(lines[lines.length - 1]).toContain('[done] a.txt');
  });

  test('EWMA converges to new speed', () => {
    const renderer = new ProgressRenderer({ isTTY: true, totalFiles: 1, totalBytes: 10000000 });

    // Simulate 10 samples at 1MB/s then 5 at 2MB/s
    // ... feed fileProgress events with controlled timing ...
    // Assert speed is between 1.5 and 2.0 MB/s (converging toward 2)
  });

  test('throttles renders to max 10/s', () => {
    const stream = createMockStream();
    const renderer = new ProgressRenderer({
      stream,
      isTTY: true,
      totalFiles: 100,
      totalBytes: 1000000,
      throttleMs: 100
    });

    // Call fileProgress 50 times in 50ms
    for (let i = 0; i < 50; i++) {
      renderer.fileProgress('file.bin', i * 1000, 1000000);
    }
    renderer.flush();

    // Should have rendered at most 2 times (initial + flush)
    const writes = stream.getLines().filter(l => l.includes('█'));
    expect(writes.length).toBeLessThanOrEqual(2);
  });
});
```

---

## Audit Finding Fixed

| Finding | Description | How Fixed |
|---------|-------------|-----------|
| ADD-002 | `clearLine()` / `cursorTo()` crash in non-TTY | TTY detection with clean fallback |

---

## Why No npm Dependency

The `progress-stream` package:
- Is a Transform stream (we don't use streams in the new design)
- Has no TTY detection
- Only tracks per-file progress (not aggregate)
- Last meaningful update: 2015

Building our own ~80-line renderer is trivial, eliminates a dependency, and gives us exactly what we need: aggregate progress with speed/ETA, proper TTY handling, and testability.
