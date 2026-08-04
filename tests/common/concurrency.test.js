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
});
