'use strict';

const fs = require('fs');
const path = require('path');

// ─── Error Classification ───────────────────────────────────────────────────

/**
 * Permanent error codes that should never be retried.
 * @type {string[]}
 */
const PERMANENT_CODES = ['EACCES', 'ENOENT', 'EISDIR', 'EPERM', 'ENAMETOOLONG'];

/**
 * Permanent error message fragments that indicate non-retryable failures.
 * @type {string[]}
 */
const PERMANENT_MESSAGES = ['PATH_ESCAPE', 'Rejected unsafe fileKey', 'path traversal'];

/**
 * Determine whether an error is retryable.
 * Non-retryable: file not found, permission denied, path traversal.
 * Retryable: timeout, checksum mismatch, connection errors, server busy.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function isRetriable(error) {
  if (error && error.code && PERMANENT_CODES.includes(error.code)) return false;
  if (error && error.message) {
    if (PERMANENT_MESSAGES.some(msg => error.message.includes(msg))) return false;
  }
  return true;
}

// ─── Exponential Backoff ────────────────────────────────────────────────────

/**
 * Calculate delay for a retry attempt using exponential backoff with jitter.
 * Formula: min(baseDelay * 2^attempt + jitter, maxDelay)
 *
 * @param {number} attempt - 0-based retry attempt (0 = first retry)
 * @param {object} [options]
 * @param {number} [options.baseDelay=1000] - Base delay in ms
 * @param {number} [options.maxDelay=30000] - Maximum delay cap in ms
 * @param {number} [options.maxJitter=500] - Maximum jitter to add in ms
 * @returns {number} Delay in ms
 */
function calculateBackoff(attempt, options = {}) {
  const { baseDelay = 1000, maxDelay = 30000, maxJitter = 500 } = options;
  const exponential = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * maxJitter;
  return Math.min(exponential + jitter, maxDelay);
}

/**
 * Create a cancellable delay promise.
 * Returns both the promise and a cancel function.
 *
 * @param {number} ms - Delay in milliseconds
 * @returns {{ promise: Promise<void>, cancel: () => void }}
 */
function cancellableDelay(ms) {
  let timer;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    timer = setTimeout(resolve, ms);
  });
  const cancel = () => {
    clearTimeout(timer);
    if (rejectFn) rejectFn(new Error('Delay cancelled'));
  };
  return { promise, cancel };
}

// ─── Retry Wrapper ──────────────────────────────────────────────────────────

/**
 * Wrap an async function with retry logic using exponential backoff.
 *
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {object} options
 * @param {number} options.maxAttempts - Total attempts (1 = no retries)
 * @param {(error: Error) => boolean} [options.shouldRetry] - Error classifier (default: isRetriable)
 * @param {(error: Error, attempt: number, delay: number) => void} [options.onRetry] - Callback before each retry
 * @param {() => boolean} [options.isAborted] - Check if operation was externally aborted
 * @param {object} [options.backoff] - Backoff options { baseDelay, maxDelay, maxJitter }
 * @returns {Promise<T>}
 * @throws Last error if all attempts exhausted, or first non-retryable error
 * @template T
 */
async function withRetry(fn, options) {
  const {
    maxAttempts = 4,
    shouldRetry = isRetriable,
    onRetry = null,
    isAborted = () => false,
    backoff = {}
  } = options;

  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (isAborted()) {
      throw lastError || new Error('Operation aborted');
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Non-retryable → throw immediately
      if (!shouldRetry(err)) {
        throw err;
      }

      // Last attempt → throw
      if (attempt >= maxAttempts - 1) {
        throw err;
      }

      // Calculate backoff delay
      const delay = calculateBackoff(attempt, backoff);

      if (onRetry) {
        onRetry(err, attempt + 1, delay);
      }

      // Wait with cancellable delay
      const { promise, cancel: _cancel } = cancellableDelay(delay);
      try {
        await promise;
      } catch (_) {
        // Delay was cancelled (e.g. SIGINT), throw the original error
        throw lastError;
      }
    }
  }

  throw lastError;
}

// ─── In-Flight Tracker ──────────────────────────────────────────────────────

/**
 * Tracks files currently being transferred.
 * On disconnect: entries become "paused" for re-queuing on reconnect.
 */
class InFlightTracker {
  constructor() {
    /** @type {Map<string, {wireKey: string, absolutePath: string, size: number, bytesSent: number, attempt: number, startedAt: number, status: string}>} */
    this._entries = new Map();
  }

  /**
   * Register a file as in-flight.
   * @param {string} wireKey
   * @param {object} info - { absolutePath, size, attempt }
   */
  register(wireKey, info) {
    this._entries.set(wireKey, {
      wireKey,
      absolutePath: info.absolutePath || '',
      size: info.size || 0,
      bytesSent: 0,
      attempt: info.attempt || 1,
      startedAt: Date.now(),
      status: 'sending'
    });
  }

  /**
   * Update bytes confirmed for an in-flight file.
   * @param {string} wireKey
   * @param {number} bytesSent
   */
  updateProgress(wireKey, bytesSent) {
    const entry = this._entries.get(wireKey);
    if (entry) {
      entry.bytesSent = bytesSent;
    }
  }

  /**
   * Mark file as completed (removes from tracker).
   * @param {string} wireKey
   */
  complete(wireKey) {
    this._entries.delete(wireKey);
  }

  /**
   * Mark file as failed (removes from tracker).
   * @param {string} wireKey
   */
  fail(wireKey) {
    this._entries.delete(wireKey);
  }

  /**
   * Mark all 'sending' entries as 'paused' (on disconnect).
   * @returns {Array<object>} The paused entries
   */
  pauseAll() {
    const paused = [];
    for (const entry of this._entries.values()) {
      if (entry.status === 'sending') {
        entry.status = 'paused';
        paused.push({ ...entry });
      }
    }
    return paused;
  }

  /**
   * Get all paused entries for re-queuing.
   * @returns {Array<object>}
   */
  getPaused() {
    const paused = [];
    for (const entry of this._entries.values()) {
      if (entry.status === 'paused') {
        paused.push({ ...entry });
      }
    }
    return paused;
  }

  /**
   * Clear paused entries (after they've been re-queued).
   */
  clearPaused() {
    for (const [key, entry] of this._entries.entries()) {
      if (entry.status === 'paused') {
        this._entries.delete(key);
      }
    }
  }

  /**
   * Get current state snapshot (for saving on SIGINT).
   * @returns {Array<{wireKey: string, bytesSent: number}>}
   */
  getSnapshot() {
    const snapshot = [];
    for (const entry of this._entries.values()) {
      snapshot.push({ wireKey: entry.wireKey, bytesSent: entry.bytesSent });
    }
    return snapshot;
  }

  /**
   * Number of currently active (sending) transfers.
   * @returns {number}
   */
  get activeCount() {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (entry.status === 'sending') count++;
    }
    return count;
  }

  /**
   * Total number of tracked entries (all statuses).
   * @returns {number}
   */
  get size() {
    return this._entries.size;
  }

  /**
   * Check if a wire key is currently tracked.
   * @param {string} wireKey
   * @returns {boolean}
   */
  has(wireKey) {
    return this._entries.has(wireKey);
  }
}

// ─── Connection State Machine ───────────────────────────────────────────────

/**
 * @typedef {'connecting'|'connected'|'transferring'|'reconnecting'|'dead'} ConnectionState
 */

const STATES = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  TRANSFERRING: 'transferring',
  RECONNECTING: 'reconnecting',
  DEAD: 'dead'
};

/**
 * Manages connection state transitions and exposes hooks for
 * the orchestrator to react to state changes.
 */
class ConnectionStateMachine {
  /**
   * @param {object} [options]
   * @param {number} [options.reconnectionAttempts=10]
   * @param {number} [options.reconnectionDelay=1000]
   * @param {number} [options.reconnectionDelayMax=30000]
   */
  constructor(options = {}) {
    this._state = STATES.CONNECTING;
    this._options = {
      reconnectionAttempts: options.reconnectionAttempts || 10,
      reconnectionDelay: options.reconnectionDelay || 1000,
      reconnectionDelayMax: options.reconnectionDelayMax || 30000
    };
    /** @type {Array<(newState: string, oldState: string) => void>} */
    this._stateChangeHandlers = [];
    /** @type {Array<() => void>} */
    this._reconnectHandlers = [];
    /** @type {Array<() => void>} */
    this._deadHandlers = [];
    this._reconnectAttempt = 0;
  }

  /** @returns {ConnectionState} */
  get state() {
    return this._state;
  }

  /** @returns {boolean} */
  get isConnected() {
    return this._state === STATES.CONNECTED || this._state === STATES.TRANSFERRING;
  }

  /** @returns {boolean} */
  get isDead() {
    return this._state === STATES.DEAD;
  }

  /**
   * Transition to a new state. Fires state change handlers.
   * @param {ConnectionState} newState
   */
  transition(newState) {
    const oldState = this._state;
    if (oldState === newState) return;
    this._state = newState;
    for (const handler of this._stateChangeHandlers) {
      handler(newState, oldState);
    }
  }

  /**
   * Handle successful connection (initial or reconnection).
   */
  handleConnected() {
    if (this._state === STATES.RECONNECTING) {
      this._reconnectAttempt = 0;
      this.transition(STATES.CONNECTED);
      for (const handler of this._reconnectHandlers) {
        handler();
      }
    } else {
      this.transition(STATES.CONNECTED);
    }
  }

  /**
   * Handle disconnect event.
   */
  handleDisconnect() {
    if (this._state === STATES.DEAD) return;
    this.transition(STATES.RECONNECTING);
  }

  /**
   * Handle reconnection attempt.
   * @returns {boolean} - true if more attempts remain, false if dead
   */
  handleReconnectAttempt() {
    this._reconnectAttempt++;
    if (this._reconnectAttempt > this._options.reconnectionAttempts) {
      this.transition(STATES.DEAD);
      for (const handler of this._deadHandlers) {
        handler();
      }
      return false;
    }
    return true;
  }

  /**
   * Handle reconnection failure (all attempts exhausted).
   */
  handleReconnectFailed() {
    this.transition(STATES.DEAD);
    for (const handler of this._deadHandlers) {
      handler();
    }
  }

  /** Mark as transferring */
  startTransferring() {
    if (this._state === STATES.CONNECTED) {
      this.transition(STATES.TRANSFERRING);
    }
  }

  /** Mark transfer complete, back to connected */
  stopTransferring() {
    if (this._state === STATES.TRANSFERRING) {
      this.transition(STATES.CONNECTED);
    }
  }

  /**
   * Register a state change handler.
   * @param {(newState: string, oldState: string) => void} handler
   */
  onStateChange(handler) {
    this._stateChangeHandlers.push(handler);
  }

  /**
   * Register a handler for successful reconnection.
   * @param {() => void} handler
   */
  onReconnect(handler) {
    this._reconnectHandlers.push(handler);
  }

  /**
   * Register a handler for permanent death.
   * @param {() => void} handler
   */
  onDead(handler) {
    this._deadHandlers.push(handler);
  }
}

// ─── SIGINT Handler ─────────────────────────────────────────────────────────

/**
 * Set up graceful SIGINT handling.
 * First SIGINT: stop dequeuing new files, let in-flight complete (with timeout).
 * Second SIGINT: force-abort.
 *
 * @param {object} context
 * @param {import('../common/concurrency').ConcurrencyPool} context.pool - The concurrency pool to pause
 * @param {InFlightTracker} context.inflight - In-flight tracker
 * @param {import('socket.io-client').Socket} context.socket - Socket to disconnect
 * @param {function} context.onShutdown - Callback invoked with {snapshot, forced} when shutdown occurs
 * @param {number} [context.graceTimeout=10000] - Grace period in ms
 * @returns {{ isShuttingDown: () => boolean, cleanup: () => void }}
 */
function setupSigintHandler(context) {
  const { pool, inflight, socket: _socket, onShutdown, graceTimeout = 10000 } = context;
  let shuttingDown = false;
  let forceKill = false;

  const handler = () => {
    if (forceKill) {
      // Third+ SIGINT — hard exit
      process.exit(130);
    }

    if (shuttingDown) {
      // Second SIGINT — force abort
      forceKill = true;
      console.error('\n[shutdown] Force quit. Writing failure report...');
      if (onShutdown) {
        onShutdown({ snapshot: inflight.getSnapshot(), forced: true });
      }
      return;
    }

    // First SIGINT — graceful
    shuttingDown = true;
    console.log('\n[shutdown] Graceful shutdown initiated. Press Ctrl+C again to force quit.');

    // Pause pool: no new files start
    pool.pause();

    // Grace period: let in-flight finish
    graceTimerRef = setTimeout(() => {
      clearTimers();
      console.log('[shutdown] Grace period expired.');
      if (onShutdown) {
        onShutdown({ snapshot: inflight.getSnapshot(), forced: false });
      }
    }, graceTimeout);

    // If pool drains naturally within grace period, we're good
    checkDrainedRef = setInterval(() => {
      if (inflight.activeCount === 0) {
        clearTimers();
        if (onShutdown) {
          onShutdown({ snapshot: [], forced: false });
        }
      }
    }, 200);
  };

  let graceTimerRef = null;
  let checkDrainedRef = null;

  function clearTimers() {
    if (graceTimerRef) { clearTimeout(graceTimerRef); graceTimerRef = null; }
    if (checkDrainedRef) { clearInterval(checkDrainedRef); checkDrainedRef = null; }
  }

  process.on('SIGINT', handler);

  return {
    isShuttingDown: () => shuttingDown,
    cleanup: () => {
      process.removeListener('SIGINT', handler);
      clearTimers();
    }
  };
}

// ─── Failed Files Report ────────────────────────────────────────────────────

/**
 * Write the failed-files.json report to the given directory.
 *
 * @param {string} outputDir - Directory to write the file (typically CWD)
 * @param {object} report
 * @param {number} report.totalFiles - Total files attempted
 * @param {number} report.succeeded - Files successfully transferred
 * @param {Array<{path: string, error: string, attempts: number}>} report.failures - Failed file details
 */
function writeFailureReport(outputDir, report) {
  const filePath = path.join(outputDir, 'failed-files.json');
  const data = {
    timestamp: new Date().toISOString(),
    totalFiles: report.totalFiles,
    succeeded: report.succeeded,
    failed: report.failures.length,
    failures: report.failures.map(f => ({
      file: f.path,
      wireKey: f.path,
      error: f.error,
      attempts: f.attempts
    }))
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return filePath;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Error classification
  isRetriable,
  PERMANENT_CODES,
  PERMANENT_MESSAGES,

  // Backoff
  calculateBackoff,
  cancellableDelay,

  // Retry
  withRetry,

  // In-flight tracking
  InFlightTracker,

  // Connection state machine
  ConnectionStateMachine,
  STATES,

  // SIGINT
  setupSigintHandler,

  // Failure report
  writeFailureReport
};
