'use strict';

/**
 * Concurrency pool that limits parallel async operations.
 * @param {number} limit - Maximum number of concurrent tasks
 */
class ConcurrencyPool {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }

  /**
   * Add a task to the pool. If under the limit, executes immediately.
   * Otherwise, queues until a slot is available.
   * @param {() => Promise<any>} taskFn - Async function to execute
   * @returns {Promise<any>} - Resolves with the task's return value
   */
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

  /**
   * Wait for all queued and running tasks to complete.
   * @param {Array<() => Promise<any>>} tasks - Array of async task functions
   * @returns {Promise<any[]>} - Resolves with array of results
   */
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
