# Phase 6 — Resilience: Context

## Current Resilience (or Lack Thereof)

The current codebase has exactly ZERO resilience features. Every error path terminates the process. This section documents the current failure modes that Phase 6 addresses.

### Current Error Handling in `client/index.js`

```js
// Line 258-261: First connect_error → immediate death
socket.on('connect_error', (err) => {
  console.error(`[error] Connection failed: ${err.message}`);
  process.exit(1);
});

// Line 251-255: Any error in the transfer flow → immediate death
} catch (err) {
  console.error(err)
  console.error('[fatal] Transfer failed:', err.message);
  process.exit(1);
}
```

```js
// Line 131-136: Stream error swallowed (resolves instead of rejects)
stream.on('error', (err) => {
  process.stdout.write('\n');
  console.error(`[error] Error sending file: ${filePath}`, err);
  resolve(); // dont reject, move to next file
});
```

Note: The stream error handler in `sendFileWithRetry` actually does provide a form of per-file isolation by resolving instead of rejecting. This is the ONE correct instinct in the entire error handling story. However, it loses the error information (the file is silently skipped with no record).

### Current `ConcurrencyPool` — The Kill Switch

```js
// common/concurrency.js:48-50
async runAll(tasks) {
  return Promise.all(tasks.map(task => this.run(task)));
}
```

`Promise.all` = one rejection kills all. Combined with the `sendFileWithRetry` function that throws `CHECKSUM_MISMATCH` after exhausting retries (line 170-171), this means: one file that consistently fails checksum → entire transfer batch aborted.

### No Disconnect Handler

There is no `socket.on('disconnect', ...)` anywhere in the client code. When the server goes down:
1. In-flight `file-ack` listeners wait forever (no timeout)
2. The `ConcurrencyPool` never drains
3. The process hangs until manually killed
4. No state is saved

### No SIGINT Handler

Neither client nor server register `process.on('SIGINT', ...)`. Ctrl+C:
- Immediately kills the process
- Half-written files left on receiver disk (at final path, not `.part`)
- No state saved
- Next run has no idea what was completed

---

## Reconnection Protocol Design

### What Happens on Disconnect

```
Timeline:
  T=0s   Client sending file-chunk for 3 concurrent files
  T=0.1s Server process killed (or network cable yanked)
  T=0.1s Socket.IO detects transport error
  T=0.2s Client receives 'disconnect' event
  
  Client actions:
  1. Connection state → RECONNECTING
  2. InFlightTracker.pauseAll() → 3 files paused
  3. Pool paused (no new tasks dequeued)
  4. Reconnection timer starts (1s base, exponential backoff)
  
  T=1.2s First reconnection attempt
  T=1.3s Server back online → connection established
  T=1.4s Client receives 'connect' event
  
  Client actions:
  5. Connection state → CONNECTED
  6. Re-emit 'session-init' (server may have lost session state)
  7. For each paused file in InFlightTracker:
     a. Emit 'file-start' with resumeOffset = lastConfirmedBytes
     b. Server acks with actual .part size
     c. Resume sending from acked offset
  8. Pool resumed (new tasks can dequeue)
```

### What If Server Lost State?

The server tracks active files in memory (`activeFiles` Map in receiver). On server restart, this Map is empty. But the `.part` files still exist on disk. The `sessions.json` still exists. So:

1. Client re-emits `session-init` with same `sessionId`
2. Client emits `file-start` for paused file
3. Server checks: `.part` exists? What size? Session matches?
4. Server acks with the `.part` size as offset
5. Client resumes from that offset

**Key insight:** The receiver is stateless in memory but stateful on disk. The `file-start` handshake re-establishes state from disk every time.

### Reconnection and the Concurrency Pool

The pool needs a "pause" mechanism during reconnection:

```js
// Modification to ConcurrencyPool:
class ConcurrencyPool {
  constructor(limit, callbacks) {
    // ...existing...
    this._paused = false;
  }

  pause() {
    this._paused = true;
    // Running tasks continue, but no new tasks start
  }

  resume() {
    this._paused = false;
    // Drain the queue
    while (this.queue.length > 0 && this.running < this.limit && !this._paused) {
      this._next();
    }
  }

  _next() {
    if (this._paused) return;  // ← New guard
    if (this.queue.length > 0 && this.running < this.limit) {
      const next = this.queue.shift();
      next();
    }
  }
}
```

---

## Retry Classification

### Retriable Errors

| Error | Why Retriable | Strategy |
|-------|---------------|----------|
| `CHECKSUM_MISMATCH` | Could be transient corruption in transit | Retry from byte 0 (full re-send) |
| `TIMEOUT` (chunk ack) | Network congestion or server busy | Retry from last confirmed offset |
| `ECONNRESET` | Connection dropped | Wait for reconnection, then retry |
| `STALL_DETECTED` | Server hung | Retry from last confirmed offset |

### Permanent Errors (No Retry)

| Error | Why Permanent | Action |
|-------|---------------|--------|
| `EACCES` | File permission won't change between retries | Mark failed, move on |
| `ENOENT` | File deleted between scan and send | Mark failed, move on |
| `PATH_ESCAPE` | Security violation in wire key | Mark failed, move on |
| `EISDIR` | Expected file, got directory | Mark failed, move on |

### Classification Function

```js
function isRetriable(error) {
  const permanentCodes = ['EACCES', 'ENOENT', 'EISDIR', 'EPERM', 'ENAMETOOLONG'];
  const permanentMessages = ['PATH_ESCAPE', 'Rejected unsafe fileKey'];

  if (error.code && permanentCodes.includes(error.code)) return false;
  if (permanentMessages.some(msg => error.message.includes(msg))) return false;

  return true; // Default: retry
}
```

---

## Stall Detection Algorithm

```
function sendFileWithStallDetection(socket, fileInfo, options):
  stallTimeout = options.stallTimeout || 30000  // 30 seconds
  
  for each chunk:
    try:
      ack = await emitWithAck(socket, 'file-chunk', payload, stallTimeout)
      // Success: reset stall state, continue
    catch (err):
      if err.message includes 'Timeout':
        // STALL DETECTED
        throw new StallError(fileInfo.wireKey, lastConfirmedOffset)
      else:
        throw err  // Other error, let retry wrapper handle

  // In the retry wrapper (withRetry):
  try:
    await sendFile(...)
  catch (err):
    if err instanceof StallError:
      // Don't immediately retry - check connection state first
      if connection.state === 'connected':
        // Server responsive on other channels? Try abort + retry
        return retry(err)
      else:
        // Connection actually dead, wait for reconnection
        await connection.waitForReconnection()
        return retry(err)
```

---

## SIGINT Handler Pseudocode

```js
let shuttingDown = false;

process.on('SIGINT', async () => {
  if (shuttingDown) {
    // Second Ctrl+C = force kill
    console.error('\nForce quit.');
    process.exit(130);
  }
  shuttingDown = true;
  console.log('\nGraceful shutdown initiated...');

  // 1. Pause the pool (no new files start)
  pool.pause();

  // 2. Give in-flight files 5s to finish their current chunk
  const graceTimeout = setTimeout(() => {
    console.log('Grace period expired, saving state...');
  }, 5000);

  // 3. Wait for running tasks to reach a save point (chunk boundary)
  // Each sender checks shuttingDown flag after each chunk:
  //   if (shuttingDown) throw new GracefulShutdownError()
  // This causes them to exit their send loop cleanly

  // 4. Save state
  const snapshot = inflightTracker.getSnapshot();
  for (const { wireKey, bytesSent } of snapshot) {
    updateFileState(sourceFolder, wireKey, {
      status: 'in-progress',
      bytesSent: bytesSent
    });
  }
  saveState(sourceFolder, state);

  // 5. Close socket
  clearTimeout(graceTimeout);
  await connection.close();

  // 6. Print summary
  const completed = Object.values(state.files).filter(f => f.status === 'completed').length;
  const inProgress = snapshot.length;
  const pending = Object.values(state.files).filter(f => f.status === 'pending').length;
  console.log(`\n${completed} completed, ${inProgress} in progress, ${pending} pending`);
  console.log('State saved. Run again to resume.');

  process.exit(0);
});
```

---

## Audit Defects Reinforced by This Phase

| Defect | Description | How Reinforced |
|--------|-------------|----------------|
| DEF-001 | `process.exit(1)` on connect_error | Replaced with state machine + reconnection attempts |
| DEF-002 | No reconnection/re-queue | Full in-flight tracker + automatic re-queue on reconnect |
| DEF-003 | Promise.all fail-fast | `runAllSettled` + per-file retry wrapper |
| DEF-011 | Timeout never cleaned up | All timeouts use `AbortController` or clearTimeout patterns |
| DEF-014 | No error on readStream | All errors caught at chunk level with `try/catch` around `readSync` |

---

## Integration with Phase 5 State

Phase 6's SIGINT handler writes state using Phase 5's `saveState()` / `updateFileState()` functions. The flow:

```
Normal completion:
  File done → updateFileState(wireKey, { status: 'completed', md5 })

Graceful shutdown:
  SIGINT → for each in-flight file:
    updateFileState(wireKey, { status: 'in-progress', bytesSent })
  → saveState()

Connection death:
  10 failed reconnections → same as graceful shutdown
  → Save state → exit 1

Next run:
  loadState() → computeResumePlan() → skip completed, resume in-progress, send pending
```

---

## Edge Cases

### Disconnect during `file-end` ack
- Sender sent all chunks + `file-end`, waiting for final ack
- Disconnect occurs before ack arrives
- On reconnection: sender emits `file-start` with full file size as `resumeOffset`
- Receiver checks: `.part` exists with full size? → Already committed (renamed to final)? Check if final file exists with expected size → ack `{ ok: true, status: 'already_complete' }`

### Disconnect during `file-start` ack
- Sender doesn't know if server got the `file-start`
- On reconnection: re-emit `file-start` — idempotent (server opens/reopens `.part`)

### File deleted while in retry backoff
- On next attempt, `fs.openSync` throws `ENOENT`
- Classified as permanent error → marked failed → not retried again

### All files fail
- `runAllSettled` returns `{ succeeded: [], failed: [...] }`
- Write `failed-files.json` with all failures
- Exit code 1
- State saved with all files as 'failed'

### Pool drained but reconnecting
- All queued files sent, but some acks pending during disconnect
- InFlightTracker has them as 'paused'
- On reconnect: re-queue only the paused files
- Pool will run them (new tasks via `pool.run()`)
