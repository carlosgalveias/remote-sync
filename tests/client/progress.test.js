'use strict';

const { ProgressRenderer } = require('../../client/progress');

/**
 * Creates a mock writable stream that captures output.
 * @param {object} [options]
 * @param {number} [options.columns] - Terminal width
 * @returns {object} Mock stream with helper methods
 */
function createMockStream(options = {}) {
  const chunks = [];
  return {
    write(data) { chunks.push(data); return true; },
    columns: options.columns || 120,
    isTTY: options.isTTY != null ? options.isTTY : true,
    getChunks() { return chunks; },
    getOutput() { return chunks.join(''); },
    getLastChunk() { return chunks[chunks.length - 1] || ''; },
    clear() { chunks.length = 0; }
  };
}

/**
 * Creates a controllable time function for testing.
 * @param {number} [start] - Initial time value
 * @returns {{ now: function, advance: function, time: number }}
 */
function createMockTime(start = 1000000) {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => { time += ms; },
    get time() { return time; }
  };
}

describe('ProgressRenderer', () => {
  describe('constructor', () => {
    test('initializes with default values', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({ total: 100, stream, now: clock.now, isTTY: true });

      const state = p.getState();
      expect(state.transferred).toBe(0);
      expect(state.skipped).toBe(0);
      expect(state.failed).toBe(0);
      expect(state.throughput).toBe(0);
      expect(state.eta).toBe(0);

      p.finish({ transferred: 0, skipped: 0, failed: 0, totalBytes: 0, elapsed: 0, throughput: 0 });
    });

    test('has zero require calls to other project modules', () => {
      // Verify module isolation by checking the source
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(path.join(__dirname, '../../client/progress.js'), 'utf8');

      // Should not require any project modules
      const requireMatches = source.match(/require\([^)]+\)/g) || [];
      expect(requireMatches.length).toBe(0);
    });
  });

  describe('onFileComplete', () => {
    test('increments transferred count', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({ total: 10, stream, now: clock.now, isTTY: true, throttleMs: 0 });

      clock.advance(1000);
      p.onFileComplete('file1.txt');

      expect(p.getState().transferred).toBe(1);
      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });

    test('initializes EWMA on first completion', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({ total: 10, stream, now: clock.now, isTTY: true, throttleMs: 0 });

      clock.advance(500); // 500ms since start
      p.onFileComplete('file1.txt');

      const state = p.getState();
      // instantRate = 1 / 0.5 = 2 files/s (bootstrap)
      expect(state.throughput).toBe(2);
      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 500, throughput: 2 });
    });

    test('updates EWMA on subsequent completions', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({ total: 10, stream, now: clock.now, isTTY: true, throttleMs: 0 });

      // First file at 1s
      clock.advance(1000);
      p.onFileComplete('file1.txt');
      // EWMA bootstrap: 1/1.0 = 1.0 files/s

      // Second file at 2s (1s after first)
      clock.advance(1000);
      p.onFileComplete('file2.txt');
      // instantRate = 1/1.0 = 1.0; ewma = 0.3*1.0 + 0.7*1.0 = 1.0

      expect(p.getState().throughput).toBeCloseTo(1.0, 2);
      p.finish({ transferred: 2, skipped: 0, failed: 0, totalBytes: 0, elapsed: 2000, throughput: 1 });
    });
  });

  describe('onFileSkipped', () => {
    test('increments both transferred and skipped counts', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({ total: 10, stream, now: clock.now, isTTY: true, throttleMs: 0 });

      clock.advance(500);
      p.onFileSkipped('file1.txt');

      const state = p.getState();
      expect(state.transferred).toBe(1);
      expect(state.skipped).toBe(1);
      p.finish({ transferred: 1, skipped: 1, failed: 0, totalBytes: 0, elapsed: 500, throughput: 2 });
    });
  });

  describe('onFileFailed', () => {
    test('increments both transferred and failed counts', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({ total: 10, stream, now: clock.now, isTTY: true, throttleMs: 0 });

      clock.advance(500);
      p.onFileFailed('file1.txt', new Error('timeout'));

      const state = p.getState();
      expect(state.transferred).toBe(1);
      expect(state.failed).toBe(1);
      p.finish({ transferred: 1, skipped: 0, failed: 1, totalBytes: 0, elapsed: 500, throughput: 2 });
    });
  });

  describe('EWMA throughput', () => {
    test('EWMA converges toward new speed (alpha=0.3)', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 20,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0,
        ewmaAlpha: 0.3
      });

      // 10 completions at 1 file/sec (1s apart)
      for (let i = 0; i < 10; i++) {
        clock.advance(1000);
        p.onFileComplete(`slow-${i}.txt`);
      }

      const afterSlow = p.getState().throughput;
      // Should be approximately 1.0 files/s
      expect(afterSlow).toBeCloseTo(1.0, 1);

      // 5 completions at 2 files/sec (500ms apart)
      for (let i = 0; i < 5; i++) {
        clock.advance(500);
        p.onFileComplete(`fast-${i}.txt`);
      }

      const afterFast = p.getState().throughput;
      // Should have converged toward 2.0 but not fully (EWMA lags)
      expect(afterFast).toBeGreaterThan(1.3);
      expect(afterFast).toBeLessThan(2.0);

      p.finish({ transferred: 15, skipped: 0, failed: 0, totalBytes: 0, elapsed: 12500, throughput: afterFast });
    });

    test('resets EWMA when gap exceeds 10 seconds (stale)', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('file1.txt');
      // EWMA bootstrap = 1.0 files/s

      // Wait 15 seconds (stale threshold is 10s)
      clock.advance(15000);
      p.onFileComplete('file2.txt');

      // Should reset: instantRate = 1/15 ≈ 0.067
      const state = p.getState();
      expect(state.throughput).toBeCloseTo(1 / 15, 2);

      p.finish({ transferred: 2, skipped: 0, failed: 0, totalBytes: 0, elapsed: 16000, throughput: state.throughput });
    });
  });

  describe('ETA calculation', () => {
    test('calculates ETA based on EWMA and remaining files', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 100,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      // Complete 10 files at 2 files/s
      for (let i = 0; i < 10; i++) {
        clock.advance(500);
        p.onFileComplete(`f${i}.txt`);
      }

      const state = p.getState();
      // remaining = 90, throughput ≈ 2.0 → ETA ≈ 45s
      expect(state.eta).toBeGreaterThan(40);
      expect(state.eta).toBeLessThan(50);

      p.finish({ transferred: 10, skipped: 0, failed: 0, totalBytes: 0, elapsed: 5000, throughput: state.throughput });
    });

    test('ETA is 0 when all files are done', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 2,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');
      clock.advance(1000);
      p.onFileComplete('f2.txt');

      expect(p.getState().eta).toBe(0);
      p.finish({ transferred: 2, skipped: 0, failed: 0, totalBytes: 0, elapsed: 2000, throughput: 1 });
    });
  });

  describe('TTY rendering', () => {
    test('renders progress bar with █ and ░', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0,
        barWidth: 36
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');
      clock.advance(1000);
      p.onFileComplete('f2.txt');

      // Force render by advancing time
      const output = stream.getOutput();
      // Should contain █ for filled and ░ for empty
      expect(output).toMatch(/\[█{1,}░+\]/);

      p.finish({ transferred: 2, skipped: 0, failed: 0, totalBytes: 0, elapsed: 2000, throughput: 1 });
    });

    test('renders counters in format N/M files', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 5678,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      expect(output).toContain('1/5678 files');

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });

    test('renders throughput in X.X files/s format', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 100,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      expect(output).toMatch(/\d+\.\d+ files\/s/);

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });

    test('renders ETA in HH:MM:SS format', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 100,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      expect(output).toMatch(/ETA \d{2}:\d{2}:\d{2}/);

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });

    test('shows failed:N inline when there are failures', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileFailed('f1.txt', 'timeout');
      clock.advance(1000);
      p.onFileFailed('f2.txt', 'error');
      clock.advance(1000);
      p.onFileFailed('f3.txt', 'fail');

      const output = stream.getOutput();
      expect(output).toContain('failed:3');

      p.finish({ transferred: 3, skipped: 0, failed: 3, totalBytes: 0, elapsed: 3000, throughput: 1 });
    });

    test('does not show failed: when there are no failures', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      expect(output).not.toContain('failed:');

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });

    test('uses \\r to overwrite the line (no newline per file)', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(500);
      p.onFileComplete('f1.txt');
      clock.advance(500);
      p.onFileComplete('f2.txt');

      const chunks = stream.getChunks();
      // Every render starts with \r
      const renderChunks = chunks.filter(c => c.startsWith('\r'));
      expect(renderChunks.length).toBeGreaterThan(0);
      // No newlines in progress renders (only in finish)
      const progressChunks = chunks.filter(c => c.startsWith('\r'));
      for (const chunk of progressChunks) {
        expect(chunk).not.toContain('\n');
      }

      p.finish({ transferred: 2, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 2 });
    });

    test('complete format matches spec: [███...░░░] N/M files  X.X files/s  ETA HH:MM:SS', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 5678,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0,
        barWidth: 36
      });

      // Complete 1234 files over time
      for (let i = 0; i < 100; i++) {
        clock.advance(100);
        p.onFileComplete(`f${i}.txt`);
      }

      const output = stream.getOutput();
      // Match the full pattern
      const pattern = /\[█{1,}░*\] \d+\/5678 files  \d+\.\d+ files\/s  ETA \d{2}:\d{2}:\d{2}/;
      expect(output).toMatch(pattern);

      p.finish({ transferred: 100, skipped: 0, failed: 0, totalBytes: 0, elapsed: 10000, throughput: 10 });
    });
  });

  describe('compact mode (narrow terminal)', () => {
    test('omits progress bar when terminal < 60 columns', () => {
      const stream = createMockStream({ columns: 50 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      // Should NOT have the bar brackets
      expect(output).not.toMatch(/\[█/);
      // Should still have counters
      expect(output).toContain('1/10 files');

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });

    test('still shows counters, throughput, and ETA in compact mode', () => {
      const stream = createMockStream({ columns: 50 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      expect(output).toMatch(/\d+\/\d+ files/);
      expect(output).toMatch(/files\/s/);
      expect(output).toMatch(/ETA/);

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });
  });

  describe('throttled redraws', () => {
    test('max 10 Hz (only renders once per 100ms minimum)', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 1000,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 100
      });

      // Fire 50 completions within the same timestamp (no time advance)
      clock.advance(1000); // initial advance to get first completion
      for (let i = 0; i < 50; i++) {
        p.onFileComplete(`f${i}.txt`);
      }

      // Only the first one should have rendered (rest are throttled since time didn't advance)
      const renderChunks = stream.getChunks().filter(c => c.startsWith('\r'));
      expect(renderChunks.length).toBeLessThanOrEqual(2);

      p.finish({ transferred: 50, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 50 });
    });

    test('renders after throttle period elapses', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 100,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 100
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');
      const countAfterFirst = stream.getChunks().filter(c => c.startsWith('\r')).length;

      // Advance past throttle
      clock.advance(150);
      p.onFileComplete('f2.txt');
      const countAfterSecond = stream.getChunks().filter(c => c.startsWith('\r')).length;

      expect(countAfterSecond).toBeGreaterThan(countAfterFirst);

      p.finish({ transferred: 2, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1150, throughput: 1.7 });
    });
  });

  describe('non-TTY fallback', () => {
    test('emits plain line with no \\r when not TTY', () => {
      const stream = createMockStream({ isTTY: false });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: false,
        nonTTYIntervalMs: 5000
      });

      // Must advance past the 5s interval to get output
      clock.advance(6000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      expect(output).not.toContain('\r');
      // Should have a newline-terminated line
      expect(output).toContain('\n');
      expect(output).toContain('1/10 files');

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 6000, throughput: 0.17 });
    });

    test('emits line every 5 seconds (not on every file)', () => {
      const stream = createMockStream({ isTTY: false });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 100,
        stream,
        now: clock.now,
        isTTY: false,
        nonTTYIntervalMs: 5000
      });

      // Complete 10 files rapidly (within 1 second)
      for (let i = 0; i < 10; i++) {
        clock.advance(100);
        p.onFileComplete(`f${i}.txt`);
      }

      // Should have 0 output lines (within 5s interval)
      const progressLines = stream.getChunks().filter(c => c.includes('files'));
      expect(progressLines.length).toBe(0);

      // Advance past 5s
      clock.advance(5000);
      p.onFileComplete('f10.txt');

      // Now should have emitted one line
      const afterLines = stream.getChunks().filter(c => c.includes('files'));
      expect(afterLines.length).toBe(1);

      p.finish({ transferred: 11, skipped: 0, failed: 0, totalBytes: 0, elapsed: 6000, throughput: 1.8 });
    });

    test('does not use ANSI codes in non-TTY mode', () => {
      const stream = createMockStream({ isTTY: false });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: false,
        nonTTYIntervalMs: 100
      });

      clock.advance(200);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      // No ANSI escape codes
      // eslint-disable-next-line no-control-regex -- intentionally matching ANSI escape sequences
      expect(output).not.toMatch(/\x1b\[/);

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 200, throughput: 5 });
    });
  });

  describe('warn()', () => {
    test('clears the line, prints warning, redraws progress in TTY', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');
      stream.clear();

      clock.advance(200);
      p.warn('Retrying file2.txt');

      const chunks = stream.getChunks();
      // Should have: clear line, warning, redraw
      const warnChunk = chunks.find(c => c.includes('[warn]'));
      expect(warnChunk).toContain('Retrying file2.txt');
      expect(warnChunk).toContain('\n');

      // Should redraw progress after the warning
      const afterWarn = chunks.slice(chunks.indexOf(warnChunk) + 1);
      const progressRedraw = afterWarn.find(c => c.includes('files'));
      expect(progressRedraw).toBeDefined();

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1200, throughput: 0.8 });
    });

    test('just prints warning with newline in non-TTY mode', () => {
      const stream = createMockStream({ isTTY: false });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: false
      });

      p.warn('Connection retry');

      const output = stream.getOutput();
      expect(output).toBe('[warn] Connection retry\n');

      p.finish({ transferred: 0, skipped: 0, failed: 0, totalBytes: 0, elapsed: 0, throughput: 0 });
    });
  });

  describe('finish()', () => {
    test('prints final summary line with checkmark', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 5678,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');
      stream.clear();

      p.finish({
        transferred: 5678,
        skipped: 0,
        failed: 0,
        totalBytes: 1288490189, // ~1.2 GB
        elapsed: 154000, // 2:34
        throughput: 37.8
      });

      const output = stream.getOutput();
      expect(output).toContain('\u2713 Transfer complete:');
      expect(output).toContain('5678 transferred');
      expect(output).toContain('0 skipped');
      expect(output).toContain('0 failed');
      expect(output).toContain('1.20 GB');
      expect(output).toContain('00:02:34');
      expect(output).toContain('37.8 files/s');
      expect(output).toContain('\n');
    });

    test('stops the render interval', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      p.finish({ transferred: 0, skipped: 0, failed: 0, totalBytes: 0, elapsed: 0, throughput: 0 });

      // After finish, further events should not render
      stream.clear();
      clock.advance(5000);
      p.onFileComplete('late.txt');

      // No new render chunks starting with \r (might get nothing or at most nothing)
      const renderChunks = stream.getChunks().filter(c => c.startsWith('\r'));
      expect(renderChunks.length).toBe(0);
    });

    test('clears TTY line before printing summary', () => {
      const stream = createMockStream({ columns: 80 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      // Record the state before finish
      const chunksBeforeFinish = stream.getChunks().length;

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 1024, elapsed: 1000, throughput: 1 });

      // After finish, first new chunk should be a line clear (\r + spaces + \r)
      const finishChunks = stream.getChunks().slice(chunksBeforeFinish);
      expect(finishChunks[0]).toMatch(/^\r +\r$/);
    });
  });

  describe('getState()', () => {
    test('returns current state snapshot', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 100,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(2000);
      p.onFileComplete('f1.txt');
      clock.advance(1000);
      p.onFileSkipped('f2.txt');
      clock.advance(1000);
      p.onFileFailed('f3.txt', 'err');

      const state = p.getState();
      expect(state.transferred).toBe(3);
      expect(state.skipped).toBe(1);
      expect(state.failed).toBe(1);
      expect(state.elapsed).toBe(4000);
      expect(state.throughput).toBeGreaterThan(0);
      expect(state.eta).toBeGreaterThan(0);

      p.finish({ transferred: 3, skipped: 1, failed: 1, totalBytes: 0, elapsed: 4000, throughput: state.throughput });
    });
  });

  describe('onChunkSent()', () => {
    test('accumulates bytes sent', () => {
      const stream = createMockStream();
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      p.onChunkSent('file1.txt', 1024);
      p.onChunkSent('file1.txt', 2048);
      p.onChunkSent('file2.txt', 512);

      // Internal bytes counter
      expect(p._bytesSent).toBe(3584);

      p.finish({ transferred: 0, skipped: 0, failed: 0, totalBytes: 3584, elapsed: 0, throughput: 0 });
    });
  });

  describe('terminal width adaptation', () => {
    test('adapts bar width to terminal columns', () => {
      const stream = createMockStream({ columns: 80 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0,
        barWidth: 60 // Larger than what would fit
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      // Line should not exceed terminal width
      const lines = output.split('\r').filter(l => l.length > 0);
      for (const line of lines) {
        // Trim trailing spaces from padding
        expect(line.trimEnd().length).toBeLessThanOrEqual(80);
      }

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });

    test('defaults to 80 columns when stream.columns is undefined', () => {
      const stream = createMockStream();
      delete stream.columns;
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      // Should not throw and should render within 80 cols
      const output = stream.getOutput();
      expect(output.length).toBeGreaterThan(0);

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });
  });

  describe('ETA formatting', () => {
    test('formats seconds correctly as HH:MM:SS', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 1000,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      // Complete 1 file in 1s → throughput ~1 file/s → remaining 999 → ETA ~999s = 00:16:39
      clock.advance(1000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      // ETA should be in HH:MM:SS format
      expect(output).toMatch(/ETA \d{2}:\d{2}:\d{2}/);

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });
  });

  describe('duration formatting', () => {
    test('formats duration for summary', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 1,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      // 2 hours, 34 minutes, 5 seconds = 9245000 ms
      p.finish({
        transferred: 1,
        skipped: 0,
        failed: 0,
        totalBytes: 1024,
        elapsed: 9245000,
        throughput: 1
      });

      const output = stream.getOutput();
      expect(output).toContain('02:34:05');
    });
  });

  describe('bytes formatting', () => {
    test('formats bytes in human-readable form', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 1,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      p.finish({
        transferred: 1,
        skipped: 0,
        failed: 0,
        totalBytes: 1288490189, // ~1.2 GB
        elapsed: 1000,
        throughput: 1
      });

      const output = stream.getOutput();
      expect(output).toContain('1.20 GB');
    });
  });

  describe('edge cases', () => {
    test('handles total of 0 files gracefully', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 0,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      // Should not throw
      p.finish({ transferred: 0, skipped: 0, failed: 0, totalBytes: 0, elapsed: 0, throughput: 0 });

      const output = stream.getOutput();
      expect(output).toContain('\u2713 Transfer complete:');
    });

    test('handles very large file counts', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 1000000,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      clock.advance(1000);
      p.onFileComplete('f1.txt');

      const output = stream.getOutput();
      expect(output).toContain('1/1000000 files');

      p.finish({ transferred: 1, skipped: 0, failed: 0, totalBytes: 0, elapsed: 1000, throughput: 1 });
    });

    test('does not render after finish is called', () => {
      const stream = createMockStream({ columns: 120 });
      const clock = createMockTime();
      const p = new ProgressRenderer({
        total: 10,
        stream,
        now: clock.now,
        isTTY: true,
        throttleMs: 0
      });

      p.finish({ transferred: 0, skipped: 0, failed: 0, totalBytes: 0, elapsed: 0, throughput: 0 });
      stream.clear();

      clock.advance(5000);
      p.onFileComplete('after-finish.txt');
      p.onChunkSent('x', 1024);

      // Should not produce any new progress renders
      const chunks = stream.getChunks().filter(c => c.startsWith('\r'));
      expect(chunks.length).toBe(0);
    });
  });
});
