'use strict';

/**
 * Concurrency pool with per-task isolation.
 * Uses allSettled semantics — one task's failure never kills others.
 *
 * Phase 6 additions:
 * - pause() / resume() — stop dequeuing new tasks during reconnection or SIGINT
 * - prepend(tasks) — add tasks to the front of the queue (for re-queuing in-flight files)
 */
class ConcurrencyPool {
  /**
   * @param {number} limit - Max concurrent tasks
   * @param {object} [callbacks]
   * @param {function} [callbacks.onTaskComplete] - (result, taskIndex) => void
   * @param {function} [callbacks.onTaskError] - (error, taskIndex) => void
   */
  constructor(limit, callbacks = {}) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
    this.callbacks = callbacks;
    this._paused = false;
  }

  /**
   * Pause the pool — running tasks continue, but no new tasks start.
   */
  pause() {
    this._paused = true;
  }

  /**
   * Resume the pool — drain queued tasks up to the concurrency limit.
   */
  resume() {
    this._paused = false;
    this._drain();
  }

  /**
   * Whether the pool is currently paused.
   * @returns {boolean}
   */
  get paused() {
    return this._paused;
  }

  /**
   * Prepend task functions to the front of the queue.
   * Each task is wrapped through the same lifecycle management as run().
   * Used to re-queue in-flight files after reconnection.
   * @param {Array<() => Promise<any>>} taskFns - Async task functions to prepend
   * @returns {Array<Promise<any>>} Promises for each prepended task
   */
  prepend(taskFns) {
    const wrappedPromises = [];
    const executors = [];
    for (const fn of taskFns) {
      const { promise, execute } = this._createTask(fn);
      wrappedPromises.push(promise);
      executors.push(execute);
    }
    // Prepend in reverse order so first task in array ends up first in queue
    this.queue.unshift(...executors);
    // Start draining if not paused
    if (!this._paused) this._drain();
    return wrappedPromises;
  }

  /**
   * Create a task wrapper that manages pool lifecycle (running count, drain).
   * @param {() => Promise<any>} taskFn
   * @returns {{ promise: Promise<any>, execute: () => void }}
   * @private
   */
  _createTask(taskFn) {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

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

    return { promise, execute };
  }

  /**
   * Run a single task when a slot is available.
   * @param {() => Promise<any>} taskFn
   * @returns {Promise<any>}
   */
  run(taskFn) {
    const { promise, execute } = this._createTask(taskFn);

    if (this.running < this.limit && !this._paused) {
      execute();
    } else {
      this.queue.push(execute);
    }

    return promise;
  }

  /**
   * Run all tasks with per-task isolation. Never rejects.
   * Each task is wrapped in its own try-catch so one failure
   * does not abort others (unlike Promise.all).
   *
   * @param {Array<() => Promise<any>>} tasks
   * @returns {Promise<{succeeded: any[], failed: Array<{index: number, error: Error}>}>}
   */
  async runAllSettled(tasks) {
    const succeeded = [];
    const failed = [];

    const promises = tasks.map((taskFn, index) => {
      return this.run(async () => {
        try {
          const result = await taskFn();
          succeeded.push(result);
          if (this.callbacks.onTaskComplete) {
            this.callbacks.onTaskComplete(result, index);
          }
        } catch (err) {
          failed.push({ index, error: err });
          if (this.callbacks.onTaskError) {
            this.callbacks.onTaskError(err, index);
          }
        }
      });
    });

    // Never rejects because inner try/catch swallows all errors
    await Promise.all(promises);
    return { succeeded, failed };
  }

  /**
   * Legacy method — runs all tasks but fails fast on first error.
   * Kept for backward compatibility with existing code paths.
   * @param {Array<() => Promise<any>>} tasks
   * @returns {Promise<any[]>}
   */
  async runAll(tasks) {
    return Promise.all(tasks.map(task => this.run(task)));
  }

  /** @private Drain queued tasks up to the concurrency limit. */
  _drain() {
    while (this.queue.length > 0 && this.running < this.limit && !this._paused) {
      const next = this.queue.shift();
      next();
    }
  }

  /** @private */
  _next() {
    if (this._paused) return;
    if (this.queue.length > 0 && this.running < this.limit) {
      const next = this.queue.shift();
      next();
    }
  }
}

module.exports = { ConcurrencyPool };
