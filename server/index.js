'use strict';

const path = require('path');
const { createServer } = require('./server');
const { DEFAULT_PORT } = require('../common/protocol');

/**
 * Start the receiver server.
 * Thin wrapper around createServer() for use as a programmatic entry point.
 *
 * @param {object} [options]
 * @param {number} [options.port] - Listen port (default: DEFAULT_PORT)
 * @param {string} [options.outputDir] - Output directory (default: CWD)
 * @param {function} [options.onConnection] - (socket) => void
 * @returns {Promise<{io: import('socket.io').Server, httpServer: import('http').Server, close: () => Promise<void>}>}
 */
async function startReceiver(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const outputDir = options.outputDir || process.cwd();

  return createServer({
    port,
    outputDir: path.resolve(outputDir),
    onConnection: options.onConnection || null
  });
}

module.exports = { startReceiver };
