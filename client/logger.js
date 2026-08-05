'use strict';

const fs = require('fs');

/**
 * Simple append-mode log file writer with ISO timestamps.
 * Writes ALL events regardless of console verbosity level.
 * If no log file is specified, all methods are no-ops.
 *
 * @module client/logger
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

class Logger {
  /**
   * @param {object} options
   * @param {string|null} [options.logFile] - Path to log file (null = disabled)
   * @param {boolean} [options.verbose] - Show debug-level on console
   * @param {boolean} [options.quiet] - Suppress non-error console output
   * @param {object} [options.progress] - ProgressRenderer instance (for warn() above bar)
   */
  constructor(options = {}) {
    this._logFile = options.logFile || null;
    this._fd = null;
    this._verbose = options.verbose || false;
    this._quiet = options.quiet || false;
    this._progress = options.progress || null;

    // Console level: quiet=error only, verbose=all, default=info
    this._consoleLevel = this._quiet ? LEVELS.error : (this._verbose ? LEVELS.debug : LEVELS.info);

    // Open log file in append mode
    if (this._logFile) {
      this._fd = fs.openSync(this._logFile, 'a');
    }
  }

  /**
   * Set the progress renderer (may be set after construction).
   * @param {object} progress - ProgressRenderer instance
   */
  setProgress(progress) {
    this._progress = progress;
  }

  /**
   * Log at error level — always shown, always logged.
   * @param {string} message
   */
  error(message) {
    this._write('error', message);
  }

  /**
   * Log at warn level — shown unless quiet, always logged.
   * @param {string} message
   */
  warn(message) {
    this._write('warn', message);
  }

  /**
   * Log at info level — shown in default/verbose mode, always logged.
   * @param {string} message
   */
  info(message) {
    this._write('info', message);
  }

  /**
   * Log at debug level — shown only with --verbose, always logged.
   * @param {string} message
   */
  debug(message) {
    this._write('debug', message);
  }

  /**
   * Close the log file descriptor.
   */
  close() {
    if (this._fd !== null) {
      fs.closeSync(this._fd);
      this._fd = null;
    }
  }

  /**
   * Internal write method.
   * @param {string} level - One of: error, warn, info, debug
   * @param {string} message
   */
  _write(level, message) {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [${level}] ${message}`;

    // Always write to log file (if open)
    if (this._fd !== null) {
      fs.writeSync(this._fd, formatted + '\n');
    }

    // Console output respects verbosity level
    const numericLevel = LEVELS[level];
    if (numericLevel > this._consoleLevel) {
      return; // Suppressed by verbosity setting
    }

    // Error always goes to stderr
    if (level === 'error') {
      process.stderr.write(formatted + '\n');
      return;
    }

    // If we have a progress renderer, use warn() to print above the bar
    if (this._progress) {
      this._progress.warn(message);
    } else {
      process.stdout.write(formatted + '\n');
    }
  }
}

module.exports = { Logger, LEVELS };
