'use strict';

/**
 * Shared protocol constants for the remote-sync chunked transfer protocol.
 * Used by both client and server modules.
 */
module.exports = {
  /** Chunk size in bytes: 128KB */
  CHUNK_SIZE: 131072,

  /** Socket.IO event names */
  EVENTS: {
    SESSION_INIT: 'session-init',
    FILE_START: 'file-start',
    FILE_CHUNK: 'file-chunk',
    FILE_END: 'file-end',
    TRANSFER_COMPLETE: 'transfer-complete',
    RESUME_QUERY: 'resume-query',
    RESUME_RESPONSE: 'resume-response'
  },

  /** Default server port */
  DEFAULT_PORT: 8000,

  /** Socket.IO server configuration */
  MAX_HTTP_BUFFER_SIZE: 100_000_000,
  PING_TIMEOUT: 120_000,
  PING_INTERVAL: 25_000
};
