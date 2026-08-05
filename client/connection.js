'use strict';

const { io } = require('socket.io-client');

/**
 * Create a Socket.IO client connection with reconnection support.
 *
 * Phase 6: Configures Socket.IO's built-in reconnection with exponential backoff.
 * - reconnectionAttempts: max retries before giving up (default: 10)
 * - reconnectionDelay: base delay in ms (default: 1000)
 * - reconnectionDelayMax: cap on delay (default: 30000)
 *
 * @param {string} server - Hostname or IP address
 * @param {number} port - Port number
 * @param {object} [options]
 * @param {number} [options.reconnectionAttempts] - Max reconnect tries (default: 10)
 * @param {number} [options.reconnectionDelay] - Base delay ms (default: 1000)
 * @param {number} [options.reconnectionDelayMax] - Max delay ms (default: 30000)
 * @param {boolean} [options.reconnection] - Enable reconnection (default: true)
 * @returns {import('socket.io-client').Socket}
 */
function createConnection(server, port, options = {}) {
  const reconnection = options.reconnection !== false;
  const reconnectionAttempts = options.reconnectionAttempts || 10;
  const reconnectionDelay = options.reconnectionDelay || 1000;
  const reconnectionDelayMax = options.reconnectionDelayMax || 30000;

  return io(`ws://${server}:${port}`, {
    reconnection,
    reconnectionAttempts,
    reconnectionDelay,
    reconnectionDelayMax,
    transports: ['websocket'],
    autoConnect: false
  });
}

/**
 * Initiate a connection and wait for it to succeed.
 * Calls socket.connect() internally, then resolves when connected or rejects on error/timeout.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {number} [timeoutMs] - Connection timeout (default: 30000)
 * @returns {Promise<void>}
 */
function connectAndWait(socket, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      reject(new Error(`Connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function onConnect() {
      clearTimeout(timer);
      socket.off('connect_error', onError);
      resolve();
    }

    function onError(err) {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      reject(new Error(`Connection failed: ${err.message}`));
    }

    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.connect();
  });
}

/**
 * Emit an event with an acknowledgement callback and timeout.
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event - Event name
 * @param {any} payload - Data to send
 * @param {number} [timeoutMs] - Ack timeout (default: 30000)
 * @returns {Promise<any>} - The ack response
 */
function emitWithAck(socket, event, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ack on '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/**
 * Attach reconnection lifecycle listeners to a socket.
 * Phase 6: Exposes Socket.IO's built-in reconnection events for the state machine.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {object} handlers
 * @param {() => void} [handlers.onDisconnect] - Called when socket disconnects
 * @param {(attempt: number) => void} [handlers.onReconnectAttempt] - Called on each reconnect attempt
 * @param {() => void} [handlers.onReconnect] - Called when socket successfully reconnects
 * @param {() => void} [handlers.onReconnectFailed] - Called when all reconnect attempts exhausted
 * @param {(err: Error) => void} [handlers.onReconnectError] - Called on each failed reconnect attempt
 * @returns {() => void} cleanup - Function to remove all listeners
 */
function attachReconnectionHandlers(socket, handlers = {}) {
  const {
    onDisconnect,
    onReconnectAttempt,
    onReconnect,
    onReconnectFailed,
    onReconnectError
  } = handlers;

  // Socket.IO v4 events
  const disconnectHandler = (reason) => {
    if (onDisconnect) onDisconnect(reason);
  };

  const reconnectAttemptHandler = (attempt) => {
    if (onReconnectAttempt) onReconnectAttempt(attempt);
  };

  const reconnectHandler = () => {
    if (onReconnect) onReconnect();
  };

  const reconnectFailedHandler = () => {
    if (onReconnectFailed) onReconnectFailed();
  };

  const reconnectErrorHandler = (err) => {
    if (onReconnectError) onReconnectError(err);
  };

  socket.on('disconnect', disconnectHandler);

  // Socket.IO Manager (.io) may not exist in test mocks
  const manager = socket.io;
  if (manager) {
    manager.on('reconnect_attempt', reconnectAttemptHandler);
    manager.on('reconnect', reconnectHandler);
    manager.on('reconnect_failed', reconnectFailedHandler);
    manager.on('reconnect_error', reconnectErrorHandler);
  }

  // Return cleanup function
  return () => {
    socket.off('disconnect', disconnectHandler);
    if (manager) {
      manager.off('reconnect_attempt', reconnectAttemptHandler);
      manager.off('reconnect', reconnectHandler);
      manager.off('reconnect_failed', reconnectFailedHandler);
      manager.off('reconnect_error', reconnectErrorHandler);
    }
  };
}

module.exports = { createConnection, connectAndWait, emitWithAck, attachReconnectionHandlers };
