'use strict';

const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const {
  MAX_HTTP_BUFFER_SIZE,
  PING_TIMEOUT,
  PING_INTERVAL,
  DEFAULT_PORT,
  EVENTS
} = require('../common/protocol');
const { registerFileHandlers, initReceiverResume } = require('./receiver');

/**
 * Get local network IPv4 addresses for display.
 * @returns {Array<{name: string, address: string}>}
 */
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ name, address: iface.address });
      }
    }
  }
  return addresses;
}

/**
 * Create and start the Socket.IO server.
 * @param {object} options
 * @param {number} [options.port] - Listen port (default: 8000)
 * @param {string} [options.outputDir] - Base output directory (default: CWD)
 * @param {function} [options.onConnection] - (socket) => void
 * @returns {Promise<{io: Server, httpServer: http.Server, close: () => Promise<void>}>}
 */
async function createServer(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const outputDir = options.outputDir || process.cwd();
  const onConnection = options.onConnection || null;

  // Phase 5: Reconcile manifest with filesystem on startup
  // Cleans stale .part files that have no manifest entries
  initReceiverResume(outputDir);

  const httpServer = http.createServer();

  const io = new Server(httpServer, {
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    pingTimeout: PING_TIMEOUT,
    pingInterval: PING_INTERVAL,
    cors: { origin: '*' }
  });

  io.on('connection', (socket) => {
    console.log(`[server] Client connected: ${socket.id}`);

    const sessionOptions = { compress: false, checksum: true, resume: true };
    let handlersRegistered = false;

    // Handle session-init with ack callback
    socket.on(EVENTS.SESSION_INIT, (payload, ack) => {
      sessionOptions.compress = !!payload.compress;
      sessionOptions.checksum = payload.checksum !== false;
      sessionOptions.resume = payload.resume !== false;
      console.log('[server] Session initialized:', JSON.stringify(sessionOptions));

      // Only register file handlers once per connection (prevents duplicate processing)
      if (!handlersRegistered) {
        registerFileHandlers(socket, outputDir, sessionOptions);
        handlersRegistered = true;
      }

      if (typeof ack === 'function') {
        ack({ ok: true });
      }
    });

    // Handle transfer-complete
    socket.on(EVENTS.TRANSFER_COMPLETE, (payload, ack) => {
      console.log(`[server] Transfer complete: ${payload.totalFiles} files, ${payload.totalBytes} bytes`);
      if (typeof ack === 'function') {
        ack({ ok: true });
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[server] Client disconnected: ${socket.id} (${reason})`);
    });

    if (onConnection) {
      onConnection(socket);
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);

    httpServer.listen(port, () => {
      console.log(`[server] Listening on port ${port}`);
      console.log('[server] Available on:');
      console.log('  localhost: 127.0.0.1');
      const localIPs = getLocalIPs();
      for (const { name, address } of localIPs) {
        console.log(`  ${name}: ${address}`);
      }
      console.log('\n[server] Waiting for connections...');

      resolve({
        io,
        httpServer,
        close: () => new Promise((res) => {
          io.close(() => {
            httpServer.close(() => res());
          });
        })
      });
    });
  });
}

module.exports = { createServer };
