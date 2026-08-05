'use strict';

const { ConcurrencyPool } = require('../../common/concurrency');

/**
 * Helper: create an async task that resolves after a given delay.
 */
function delayTask(ms, value) {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * Helper: create an async task that rejects after a given delay.
 */
function rejectTask(ms, error) {
  return () => new Promise((_, reject) => setTimeout(() => reject(error), ms));
}

describe('ConcurrencyPool', () => {
  it('should limit concurrent tasks to the specified limit', async () => {
    const pool = new ConcurrencyPool(2);
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const createTask = (ms) => () => new Promise((resolve) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      setTimeout(() => {
        currentConcurrent--;
        resolve();
      }, ms);
    });

    const tasks = [
      createTask(50),
      createTask(50),
      createTask(50),
      createTask(50),
      createTask(50)
    ];

    await pool.runAll(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBe(2);
  });

  it('should execute all tasks eventually', async () => {
    const pool = new ConcurrencyPool(2);
    const executed = [];

    const tasks = [0, 1, 2, 3, 4].map((i) => () => {
      executed.push(i);
      return Promise.resolve(i);
    });

    await pool.runAll(tasks);
    expect(executed).toHaveLength(5);
    expect(executed.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('should return correct results from run()', async () => {
    const pool = new ConcurrencyPool(3);
    const result = await pool.run(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('should return all results from runAll()', async () => {
    const pool = new ConcurrencyPool(2);
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c')
    ];

    const results = await pool.runAll(tasks);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('should handle rejected tasks without stopping others', async () => {
    const pool = new ConcurrencyPool(2);
    const results = [];

    const task1 = pool.run(() => Promise.resolve('ok1')).then(v => { results.push(v); });
    const task2 = pool.run(() => Promise.reject(new Error('fail'))).catch(() => { results.push('caught'); });
    const task3 = pool.run(() => Promise.resolve('ok3')).then(v => { results.push(v); });

    await Promise.all([task1, task2, task3]);

    expect(results).toContain('ok1');
    expect(results).toContain('caught');
    expect(results).toContain('ok3');
  });

  it('should process queue in order', async () => {
    const pool = new ConcurrencyPool(1);
    const order = [];

    const tasks = [0, 1, 2, 3].map((i) => () => {
      order.push(i);
      return Promise.resolve(i);
    });

    await pool.runAll(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('should work with limit of 1 (sequential)', async () => {
    const pool = new ConcurrencyPool(1);
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = [10, 20, 30].map((ms) => () => new Promise((resolve) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      setTimeout(() => {
        concurrent--;
        resolve(ms);
      }, ms);
    }));

    const results = await pool.runAll(tasks);
    expect(maxConcurrent).toBe(1);
    expect(results).toEqual([10, 20, 30]);
  });

  describe('prepend()', () => {
    it('should wrap tasks with proper lifecycle (running count and concurrency limit)', async () => {
      const pool = new ConcurrencyPool(2);
      let maxConcurrent = 0;
      let currentConcurrent = 0;
      const order = [];

      const createTrackedTask = (id, ms) => () => new Promise((resolve) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        order.push(id);
        setTimeout(() => {
          currentConcurrent--;
          resolve(id);
        }, ms);
      });

      // Pause pool, queue some tasks via run(), then prepend others
      pool.pause();

      // Queue via run (these go to the back)
      const runP1 = pool.run(createTrackedTask('run-1', 30));
      const runP2 = pool.run(createTrackedTask('run-2', 30));
      const runP3 = pool.run(createTrackedTask('run-3', 30));

      // Prepend tasks (these should go to the front)
      const prependPromises = pool.prepend([
        createTrackedTask('prepend-1', 30),
        createTrackedTask('prepend-2', 30)
      ]);

      // Resume — tasks should drain respecting concurrency
      pool.resume();

      // Await all
      const results = await Promise.all([...prependPromises, runP1, runP2, runP3]);

      // Prepended tasks ran first
      expect(order[0]).toBe('prepend-1');
      expect(order[1]).toBe('prepend-2');

      // Concurrency limit was respected
      expect(maxConcurrent).toBeLessThanOrEqual(2);

      // All tasks completed (running count decremented properly, no stall)
      expect(results).toEqual(['prepend-1', 'prepend-2', 'run-1', 'run-2', 'run-3']);
    });

    it('should decrement running and call _next on task failure', async () => {
      const pool = new ConcurrencyPool(1);
      const results = [];

      pool.pause();

      // Prepend a failing task followed by a succeeding task
      const prependPromises = pool.prepend([
        () => Promise.reject(new Error('boom')),
        () => { results.push('ok'); return Promise.resolve('ok'); }
      ]);

      pool.resume();

      // First promise should reject
      await expect(prependPromises[0]).rejects.toThrow('boom');
      // Second should succeed (proves _next was called after failure)
      await expect(prependPromises[1]).resolves.toBe('ok');
      expect(results).toEqual(['ok']);
    });

    it('should start draining immediately when not paused', async () => {
      const pool = new ConcurrencyPool(2);
      const order = [];

      // Pool is NOT paused, so prepend should start draining
      const prependPromises = pool.prepend([
        () => { order.push('a'); return Promise.resolve('a'); },
        () => { order.push('b'); return Promise.resolve('b'); }
      ]);

      const results = await Promise.all(prependPromises);
      expect(results).toEqual(['a', 'b']);
      expect(order).toEqual(['a', 'b']);
    });
  });
});
