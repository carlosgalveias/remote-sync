'use strict';

/**
 * Single-line progress renderer for remote-sync CLI.
 * Fully isolated — zero imports from other project modules.
 * Receives events, renders a self-updating terminal line.
 *
 * Output format (TTY):
 *   [████████████████████░░░░░░░░░░░░░░░░] 1234/5678 files  12.4 files/s  ETA 00:05:57
 *
 * When failures exist:
 *   [████████████████████░░░░░░░░░░░░░░░░] 1234/5678 files  12.4 files/s  ETA 00:05:57  failed:3
 *
 * Non-TTY fallback: periodic plain lines every 5s, no \r or ANSI codes.
 *
 * @module client/progress
 */

const DEFAULT_BAR_WIDTH = 36;
const COMPACT_THRESHOLD = 60;
const EWMA_ALPHA = 0.3;
const THROTTLE_MS = 100;
const NON_TTY_INTERVAL_MS = 5000;
const STALE_THRESHOLD_MS = 10000;

class ProgressRenderer {
  /**
   * @param {object} options
   * @param {number} options.total - Total number of files to transfer
   * @param {NodeJS.WritableStream} [options.stream] - Writable stream (default: process.stdout)
   * @param {function} [options.now] - Time function for testability (default: Date.now)
   * @param {number} [options.throttleMs] - Min ms between redraws (default: 100)
   * @param {number} [options.barWidth] - Progress bar width in chars (default: 36)
   * @param {number} [options.ewmaAlpha] - EWMA smoothing factor (default: 0.3)
   * @param {boolean} [options.isTTY] - Override TTY detection (for testing)
   * @param {number} [options.nonTTYIntervalMs] - Non-TTY emit interval (default: 5000)
   */
  constructor(options = {}) {
    this._total = options.total || 0;
    this._stream = options.stream || process.stdout;
    this._now = options.now || Date.now;
    this._throttleMs = options.throttleMs != null ? options.throttleMs : THROTTLE_MS;
    this._barWidth = options.barWidth != null ? options.barWidth : DEFAULT_BAR_WIDTH;
    this._alpha = options.ewmaAlpha != null ? options.ewmaAlpha : EWMA_ALPHA;
    this._nonTTYIntervalMs = options.nonTTYIntervalMs != null ? options.nonTTYIntervalMs : NON_TTY_INTERVAL_MS;

    // TTY detection: explicit override or check stream
    if (options.isTTY != null) {
      this._isTTY = options.isTTY;
    } else {
      this._isTTY = !!(this._stream && this._stream.isTTY);
    }

    // State
    this._transferred = 0;
    this._skipped = 0;
    this._failed = 0;
    this._bytesSent = 0;
    this._startTime = this._now();
    this._lastRenderTime = 0;
    this._lastLineLength = 0;
    this._finished = false;

    // EWMA state (files/second)
    this._ewma = 0;
    this._lastCompletionTime = 0;
    this._ewmaInitialized = false;

    // Non-TTY periodic output
    this._lastNonTTYTime = this._now();

    // Timer for periodic rendering (TTY) — schedule redraw interval
    this._renderInterval = null;
    if (this._isTTY) {
      this._renderInterval = setInterval(() => {
        if (!this._finished) {
          this._renderLine(true);
        }
      }, this._throttleMs);
      // Don't hold the process open
      if (this._renderInterval.unref) {
        this._renderInterval.unref();
      }
    }
  }

  /**
   * A file finished successfully (transferred).
   * @param {string} wireKey - File identifier
   */
  onFileComplete(_wireKey) {
    this._transferred++;
    this._updateEWMA();
    this._scheduleRender();
  }

  /**
   * A file was skipped (already complete on server).
   * @param {string} wireKey - File identifier
   */
  onFileSkipped(_wireKey) {
    this._transferred++;
    this._skipped++;
    this._updateEWMA();
    this._scheduleRender();
  }

  /**
   * A file failed after all retries.
   * @param {string} wireKey - File identifier
   * @param {Error|string} error - The failure reason
   */
  onFileFailed(_wireKey, _error) {
    this._transferred++;
    this._failed++;
    this._updateEWMA();
    this._scheduleRender();
  }

  /**
   * Bytes sent for a file (for byte-level tracking).
   * @param {string} wireKey - File identifier
   * @param {number} bytes - Bytes in this chunk
   */
  onChunkSent(wireKey, bytes) {
    this._bytesSent += bytes;
    this._scheduleRender();
  }

  /**
   * Print a warning message without corrupting the progress line.
   * @param {string} message - Warning text
   */
  warn(message) {
    if (this._isTTY) {
      // Clear current progress line
      const cols = this._getColumns();
      this._stream.write('\r' + ' '.repeat(Math.min(cols, this._lastLineLength)) + '\r');
      // Print warning with newline
      this._stream.write(`[warn] ${message}\n`);
      // Redraw progress line
      this._renderLine(true);
    } else {
      this._stream.write(`[warn] ${message}\n`);
    }
  }

  /**
   * Print final summary and stop rendering.
   * @param {object} summary
   * @param {number} summary.transferred - Files transferred successfully
   * @param {number} summary.skipped - Files skipped
   * @param {number} summary.failed - Files failed
   * @param {number} summary.totalBytes - Total bytes transferred
   * @param {number} summary.elapsed - Elapsed time in ms
   * @param {number} summary.throughput - Final throughput (files/s)
   */
  finish(summary) {
    this._finished = true;

    // Stop interval
    if (this._renderInterval) {
      clearInterval(this._renderInterval);
      this._renderInterval = null;
    }

    const elapsed = summary.elapsed || (this._now() - this._startTime);
    const throughput = summary.throughput || (elapsed > 0 ? (this._transferred / (elapsed / 1000)) : 0);
    const transferred = summary.transferred != null ? summary.transferred : this._transferred;
    const skipped = summary.skipped != null ? summary.skipped : this._skipped;
    const failed = summary.failed != null ? summary.failed : this._failed;
    const totalBytes = summary.totalBytes != null ? summary.totalBytes : this._bytesSent;

    if (this._isTTY) {
      // Clear the progress line
      const cols = this._getColumns();
      this._stream.write('\r' + ' '.repeat(Math.min(cols, this._lastLineLength)) + '\r');
    }

    // Format duration
    const durationStr = this._formatDuration(elapsed);
    // Format bytes
    const bytesStr = this._formatBytes(totalBytes);
    // Format throughput
    const tpStr = throughput.toFixed(1);

    const line = `\u2713 Transfer complete: ${transferred} transferred, ${skipped} skipped, ${failed} failed | ${bytesStr} | ${durationStr} | ${tpStr} files/s`;
    this._stream.write(line + '\n');
  }

  /**
   * Get current internal state (for testing).
   * @returns {{ transferred: number, skipped: number, failed: number, elapsed: number, throughput: number, eta: number }}
   */
  getState() {
    const elapsed = this._now() - this._startTime;
    const remaining = Math.max(0, this._total - this._transferred);
    const eta = this._ewma > 0 ? remaining / this._ewma : 0;

    return {
      transferred: this._transferred,
      skipped: this._skipped,
      failed: this._failed,
      elapsed,
      throughput: this._ewma,
      eta
    };
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Update EWMA throughput based on file completion events.
   */
  _updateEWMA() {
    const now = this._now();

    if (!this._ewmaInitialized) {
      // Bootstrap: use time since start for first completion
      const timeSinceStart = (now - this._startTime) / 1000;
      if (timeSinceStart > 0) {
        this._ewma = 1 / timeSinceStart;
      } else {
        this._ewma = 1;
      }
      this._ewmaInitialized = true;
      this._lastCompletionTime = now;
      return;
    }

    const timeSinceLast = (now - this._lastCompletionTime) / 1000;

    if (timeSinceLast > STALE_THRESHOLD_MS / 1000) {
      // Reset EWMA if stale (> 10s between completions)
      if (timeSinceLast > 0) {
        this._ewma = 1 / timeSinceLast;
      }
      this._lastCompletionTime = now;
      return;
    }

    if (timeSinceLast > 0) {
      const instantRate = 1 / timeSinceLast;
      this._ewma = this._alpha * instantRate + (1 - this._alpha) * this._ewma;
    }

    this._lastCompletionTime = now;
  }

  /**
   * Schedule a render (respects throttle).
   */
  _scheduleRender() {
    if (this._finished) return;

    if (this._isTTY) {
      this._renderLine(false);
    } else {
      this._renderNonTTY();
    }
  }

  /**
   * Render the progress line (TTY mode).
   * @param {boolean} force - Ignore throttle if true
   */
  _renderLine(force) {
    if (this._finished) return;

    const now = this._now();
    if (!force && (now - this._lastRenderTime) < this._throttleMs) {
      return;
    }
    this._lastRenderTime = now;

    const cols = this._getColumns();
    const fraction = this._total > 0 ? this._transferred / this._total : 0;
    const remaining = Math.max(0, this._total - this._transferred);

    // Counters
    const countersStr = `${this._transferred}/${this._total} files`;

    // Throughput
    const throughputStr = this._ewma > 0
      ? `${this._ewma.toFixed(1)} files/s`
      : '-- files/s';

    // ETA
    const etaStr = this._ewma > 0 && remaining > 0
      ? `ETA ${this._formatETA(remaining / this._ewma)}`
      : 'ETA --:--:--';

    // Failed suffix
    const failedStr = this._failed > 0 ? `  failed:${this._failed}` : '';

    let line;

    if (cols < COMPACT_THRESHOLD) {
      // Compact mode: no bar, just counters
      line = `${countersStr}  ${throughputStr}  ${etaStr}${failedStr}`;
    } else {
      // Calculate bar width: adapt to terminal width
      // Format: [███...░░░] N/M files  X.X files/s  ETA HH:MM:SS  failed:N
      // Fixed parts: "[] " + counters + "  " + throughput + "  " + eta + failed
      const fixedLength = 3 + countersStr.length + 2 + throughputStr.length + 2 + etaStr.length + failedStr.length;
      const availableForBar = Math.max(10, cols - fixedLength - 1); // -1 for \r safety
      const barWidth = Math.min(this._barWidth, availableForBar);

      const filled = Math.round(fraction * barWidth);
      const empty = barWidth - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);

      line = `[${bar}] ${countersStr}  ${throughputStr}  ${etaStr}${failedStr}`;
    }

    // Pad to overwrite previous longer line
    const padding = Math.max(0, this._lastLineLength - line.length);
    this._stream.write('\r' + line + ' '.repeat(padding));
    this._lastLineLength = line.length;
  }

  /**
   * Render in non-TTY mode (periodic plain lines).
   */
  _renderNonTTY() {
    const now = this._now();
    if ((now - this._lastNonTTYTime) < this._nonTTYIntervalMs) {
      return;
    }
    this._lastNonTTYTime = now;

    const countersStr = `${this._transferred}/${this._total} files`;
    const throughputStr = this._ewma > 0
      ? `${this._ewma.toFixed(1)} files/s`
      : '-- files/s';
    const remaining = Math.max(0, this._total - this._transferred);
    const etaStr = this._ewma > 0 && remaining > 0
      ? `ETA ${this._formatETA(remaining / this._ewma)}`
      : 'ETA --:--:--';
    const failedStr = this._failed > 0 ? `  failed:${this._failed}` : '';

    this._stream.write(`${countersStr}  ${throughputStr}  ${etaStr}${failedStr}\n`);
  }

  /**
   * Format seconds into HH:MM:SS.
   * @param {number} seconds
   * @returns {string}
   */
  _formatETA(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--:--:--';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  /**
   * Format elapsed duration for summary line (HH:MM:SS).
   * @param {number} ms - Duration in milliseconds
   * @returns {string}
   */
  _formatDuration(ms) {
    const totalSeconds = Math.round(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Format bytes into human-readable form.
   * @param {number} bytes
   * @returns {string}
   */
  _formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }

  /**
   * Get terminal column width.
   * @returns {number}
   */
  _getColumns() {
    return (this._stream && this._stream.columns) || 80;
  }
}

module.exports = { ProgressRenderer };
