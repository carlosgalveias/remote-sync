# Phase 6 — Resilience: Requirements

## Scope

Add per-file failure isolation, bounded retries with exponential backoff, automatic reconnection with in-flight re-queuing, stall detection, and graceful shutdown. After this phase, the tool can survive real-world network conditions: drops, hangs, flaky connections, and user interruption.

---

## Files to Create

| File | Purpose |
|------|---------|
| `client/retry.js` | Exponential backoff calculator with jitter |
| `client/inflight.js` | In-flight transfer tracker — knows which files are mid-stream |

## Files to Modify

| File | Change |
|------|--------|
| `client/connection.js` | Full state machine: connecting → connected → reconnecting → dead |
| `client/sender.js` | Wrap send in retry logic, add stall timeout per chunk ack |
| `client/index.js` | SIGINT handler, final failure report, reconnection re-queue |
| `common/concurrency.js` | Expose active task count, drain capability for reconnection |

---

## Design Decisions

### 1. Connection State Machine

```
                  ┌─────────┐
     start ──────►│CONNECTING│
                  └────┬─────┘
                       │ connected
                       ▼
                  ┌─────────┐
            ┌─────│CONNECTED │◄──────────┐
            │     └────┬─────┘           │
            │          │ disconnect       │ reconnected
            │          ▼                  │
            │     ┌──────────────┐       │
            │     │ RECONNECTING │───────┘
            │     └──────┬───────┘
            │            │ max attempts exceeded
            │            ▼
            │     ┌──────────┐
            └─────►│  DEAD    │
                   └──────────┘
                (connect timeout)
```

States:
- **CONNECTING:** Initial connection attempt. If fails after timeout → DEAD.
- **CONNECTED:** Normal operation. Transfers proceed.
- **RECONNECTING:** Socket disconnected. All in-flight files are paused (not abandoned). Retry connection with backoff. If reconnected → re-queue in-flight files. If max attempts → DEAD.
- **DEAD:** Unrecoverable. Save state, generate failure report, exit with code 1.

### 2. In-Flight Tracker

The in-flight tracker maintains a `Map<wireKey, InFlightState>`:

```js
/**
 * @typedef {Object} InFlightState
 * @property {string} wireKey
 * @property {string} absolutePath
 * @property {number} size
 * @property {number} bytesSent - Bytes confirmed received (last acked chunk)
 * @property {number} attempt - Current attempt number (1-based)
 * @property {number} startedAt - Timestamp when this attempt started
 * @property {'sending'|'paused'|'retrying'} status
 */
```

On disconnect:
1. All entries with status `'sending'` → set to `'paused'`
2. Their promises are NOT rejected (they await reconnection)
3. On reconnection: paused entries are re-queued through the pool

On successful file completion:
- Entry removed from tracker

On max retries exceeded:
- Entry moved to `failedFiles` list
- Entry removed from tracker

### 3. Retry with Exponential Backoff + Jitter

```js
/**
 * Calculate delay for retry attempt.
 * @param {number} attempt - 1-based attempt number (1 = first retry)
 * @param {object} [options]
 * @param {number} [options.baseDelay] - Base delay in ms (default: 1000)
 * @param {number} [options.maxDelay] - Cap in ms (default: 30000)
 * @param {number} [options.jitterFactor] - 0-1, fraction of randomness (default: 0.25)
 * @returns {number} - Delay in ms
 */
function calculateBackoff(attempt, options = {}) {
  const { baseDelay = 1000, maxDelay = 30000, jitterFactor = 0.25 } = options;
  const exponential = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
  const jitter = exponential * jitterFactor * (Math.random() * 2 - 1); // ±25%
  return Math.max(0, Math.round(exponential + jitter));
}
```

Sequence: ~1s, ~2s, ~4s (then give up at default 3 max retries).

### 4. Stall Detection

A "stall" is when the sender emits a `file-chunk` but never receives the ack. This happens when:
- Server crashed silently (no FIN sent)
- Network partition (packets black-holed)
- Server's disk is full and write hangs

**Detection:** Per-chunk ack has a timeout. If no ack within `stallTimeout` (default: 30s):
1. Abort the current file transfer
2. Mark as failed for this attempt
3. If retries remaining → schedule retry after backoff
4. If no retries → mark permanently failed

**Implementation:**
```js
// In sender.js send loop:
const ackPromise = emitWithAck(socket, 'file-chunk', payload, stallTimeout);
// emitWithAck already has timeout built in (from Phase 4)
// If it rejects with timeout → stall detected
```

### 5. Graceful SIGINT Handling

When user presses Ctrl+C:
1. Set `shuttingDown = true` flag
2. Stop dequeuing new files from the pool
3. Wait for in-flight chunks to complete (up to 5s grace period)
4. Save current state to `.remote-sync/state.json` (with in-progress files and their byte offsets)
5. Emit `transfer-complete` with partial stats
6. Close socket cleanly
7. Print summary: "X files completed, Y in progress (will resume), Z pending"
8. Exit with code 0 (successful graceful shutdown) or 130 (standard SIGINT exit)

**Why exit 0?** Because the state is saved — the next run will resume. It's not a failure; it's a pause.

### 6. Per-File Isolation

The `ConcurrencyPool.runAllSettled` (from Phase 4) already provides task isolation. Phase 6 adds:
- Each task wraps `sendFile` in a retry loop
- Each task catches ALL errors (network, disk, timeout, checksum mismatch)
- Failed files are collected, never propagate to kill other files

```js
// In client/index.js orchestrator:
const tasks = filesToSend.map((file) => {
  return () => sendWithRetry(socket, file, options, {
    maxAttempts: options.retries,
    inflight: inflightTracker,
    onProgress: progressCallback
  });
});

const { succeeded, failed } = await pool.runAllSettled(tasks);
```

### 7. Failure Report

On completion (or DEAD state), write `failed-files.json` in CWD:

```json
{
  "timestamp": "2024-01-15T10:45:00.000Z",
  "totalFiles": 1500,
  "succeeded": 1497,
  "failed": 3,
  "failures": [
    {
      "file": "src/corrupt.bin",
      "wireKey": "src/corrupt.bin",
      "error": "CHECKSUM_MISMATCH",
      "attempts": 3
    },
    {
      "file": "assets/locked.pdf",
      "wireKey": "assets/locked.pdf",
      "error": "EACCES: permission denied",
      "attempts": 1
    }
  ]
}
```

Exit code: `1` if any files failed. `0` if all succeeded (or graceful shutdown with state saved).

---

## Interface Contracts

### `client/retry.js`

```js
/**
 * @param {number} attempt - 1-based attempt number
 * @param {object} [options] - { baseDelay, maxDelay, jitterFactor }
 * @returns {number} - Delay in ms
 */
function calculateBackoff(attempt, options) { ... }

/**
 * Wrap an async function with retry logic.
 * @param {() => Promise<T>} fn - The async function to retry
 * @param {object} options
 * @param {number} options.maxAttempts - Total attempts (including first)
 * @param {function} [options.shouldRetry] - (error) => boolean (default: always retry)
 * @param {function} [options.onRetry] - (error, attempt, delay) => void
 * @returns {Promise<T>}
 * @throws Last error if all attempts exhausted
 */
async function withRetry(fn, options) { ... }
```

### `client/inflight.js`

```js
class InFlightTracker {
  constructor() { ... }

  /**
   * Register a file as in-flight.
   * @param {string} wireKey
   * @param {object} info - { absolutePath, size, attempt }
   */
  register(wireKey, info) { ... }

  /**
   * Update bytes confirmed for an in-flight file.
   * @param {string} wireKey
   * @param {number} bytesSent
   */
  updateProgress(wireKey, bytesSent) { ... }

  /**
   * Mark file as completed (removes from tracker).
   * @param {string} wireKey
   */
  complete(wireKey) { ... }

  /**
   * Mark all 'sending' entries as 'paused' (on disconnect).
   * @returns {Array<InFlightState>} - The paused entries
   */
  pauseAll() { ... }

  /**
   * Get all paused entries for re-queuing.
   * @returns {Array<InFlightState>}
   */
  getPaused() { ... }

  /**
   * Get current state snapshot (for saving to state.json on SIGINT).
   * @returns {Array<{wireKey: string, bytesSent: number}>}
   */
  getSnapshot() { ... }

  /**
   * Number of currently active (sending) transfers.
   * @returns {number}
   */
  get activeCount() { ... }
}
```

### Modified `client/connection.js`

```js
/**
 * @typedef {'connecting'|'connected'|'reconnecting'|'dead'} ConnectionState
 */

class Connection {
  /**
   * @param {string} server
   * @param {number} port
   * @param {object} [options]
   * @param {number} [options.connectTimeout] - ms (default: 30000)
   * @param {number} [options.reconnectionAttempts] - (default: 10)
   * @param {number} [options.reconnectionBaseDelay] - ms (default: 1000)
   */
  constructor(server, port, options = {}) { ... }

  /** @returns {ConnectionState} */
  get state() { ... }

  /** @returns {Socket} - The underlying socket.io-client socket */
  get socket() { ... }

  /**
   * Connect and wait for the connection to be established.
   * @returns {Promise<void>}
   * @throws {Error} if connect timeout exceeded
   */
  async connect() { ... }

  /**
   * Register a handler for state changes.
   * @param {(newState: ConnectionState, oldState: ConnectionState) => void} handler
   */
  onStateChange(handler) { ... }

  /**
   * Register a handler for successful reconnection.
   * @param {() => void} handler
   */
  onReconnect(handler) { ... }

  /**
   * Cleanly close the connection.
   * @returns {Promise<void>}
   */
  async close() { ... }

  /**
   * Emit with ack, respecting connection state.
   * If disconnected, waits for reconnection (up to timeout) before emitting.
   * @param {string} event
   * @param {any} payload
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  async emitWithAck(event, payload, timeoutMs = 30000) { ... }
}
```

---

## Acceptance Criteria

1. Kill server mid-transfer (5 concurrent files) → client detects disconnect within 5s → enters RECONNECTING → restart server → client reconnects → resumes the 5 in-flight files → transfer completes
2. One file has `EACCES` (permission denied) → file fails after 1 attempt (not retried for permission errors) → all other files transfer successfully → exit code 1 → `failed-files.json` lists the one failure
3. Simulate stall (server receives chunk but never acks) → client detects stall after 30s → aborts file → retries from last confirmed offset → succeeds on retry
4. Ctrl+C during transfer → state saved within 2s → next `remote-sync send` resumes from saved state
5. Three consecutive checksum mismatches on same file → file marked failed → transfer continues for other files → `failed-files.json` reports it
6. Connection fails 10 times with backoff → state DEAD → state saved → exit 1 → "Connection lost permanently" message
7. Backoff delays are: ~1s, ~2s, ~4s, ~8s, ~16s, ~30s, ~30s, ~30s, ~30s, ~30s (capped at 30s)
8. `--retries 0` means: 1 attempt only, no retries. Still isolated (one failure doesn't kill batch).
9. After graceful shutdown + resume: total bytes transferred across both runs equals file size (no duplicate work beyond 1 overlapping chunk per resumed file)

---

## Constraints

- **DO NOT** retry on `EACCES`, `ENOENT`, or path validation errors (permanent failures)
- **DO NOT** retry indefinitely — respect `--retries` flag (default: 3 = 1 initial + 3 retries = 4 total attempts)
- **DO NOT** hold file descriptors open during backoff wait
- **DO NOT** buffer in-flight file data in memory during reconnection (only track metadata)
- **DO NOT** kill the pool on reconnection — pause it
- **DO** distinguish retriable errors (network timeout, stall, checksum mismatch) from permanent errors (EACCES, ENOENT, path escape)
- **DO** use the existing `ConcurrencyPool.runAllSettled` — don't replace it
- **DO** ensure the backoff timer is cancellable (for SIGINT during backoff)

---

## Dependencies

- **Phase 4 complete:** Core protocol with ack-based backpressure must work.
- **Phase 5 complete:** State persistence needed for SIGINT save and resume-after-disconnect.
