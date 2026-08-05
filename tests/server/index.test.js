'use strict';

const path = require('path');
const EventEmitter = require('events');

// Mock http module
jest.mock('http', () => ({
  createServer: jest.fn(() => {
    const server = new (require('events').EventEmitter)();
    server.listen = jest.fn((port, cb) => {
      setImmediate(() => cb());
    });
    server.close = jest.fn((cb) => {
      if (cb) setImmediate(cb);
    });
    return server;
  })
}));

// Mock socket.io Server class
jest.mock('socket.io', () => {
  const { EventEmitter } = require('events');
  return {
    Server: jest.fn(function(httpServer, options) {
      const io = new EventEmitter();
      io.close = jest.fn((cb) => {
        if (cb) setImmediate(cb);
      });
      return io;
    })
  };
});

describe('server/index - startReceiver', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should export startReceiver as a function', () => {
    const { startReceiver } = require('../../server/index');
    expect(typeof startReceiver).toBe('function');
  });

  it('should call createServer with the correct port and outputDir', async () => {
    const { startReceiver } = require('../../server/index');
    const result = await startReceiver({ port: 9000, outputDir: '/tmp/output' });

    expect(result).toHaveProperty('io');
    expect(result).toHaveProperty('httpServer');
    expect(result).toHaveProperty('close');
    expect(typeof result.close).toBe('function');
  });

  it('should use default port and CWD if no options provided', async () => {
    const { startReceiver } = require('../../server/index');
    const result = await startReceiver();

    expect(result).toHaveProperty('io');
    expect(result).toHaveProperty('httpServer');
  });
});

describe('server/server - createServer', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should export createServer as a function', () => {
    const { createServer } = require('../../server/server');
    expect(typeof createServer).toBe('function');
  });

  it('should return io, httpServer, and close function', async () => {
    const { createServer } = require('../../server/server');
    const result = await createServer({ port: 8888, outputDir: '/tmp' });

    expect(result).toHaveProperty('io');
    expect(result).toHaveProperty('httpServer');
    expect(result).toHaveProperty('close');
    expect(typeof result.close).toBe('function');
  });

  it('should register connection handler on io', async () => {
    const { createServer } = require('../../server/server');
    const result = await createServer({ port: 8888, outputDir: '/tmp' });

    // Check that 'connection' listener is registered
    expect(result.io.listenerCount('connection')).toBe(1);
  });

  it('should handle session-init and prevent duplicate handler registration', async () => {
    const { createServer } = require('../../server/server');
    const result = await createServer({ port: 8888, outputDir: '/tmp' });

    // Simulate a client connecting
    const mockSocket = new EventEmitter();
    mockSocket.id = 'test-socket-id';
    result.io.emit('connection', mockSocket);

    // Get session-init listeners count
    const sessionInitListeners = mockSocket.listenerCount('session-init');
    expect(sessionInitListeners).toBe(1);

    // Call session-init twice
    const ack1 = jest.fn();
    const ack2 = jest.fn();
    mockSocket.emit('session-init', { compress: true, checksum: true }, ack1);
    mockSocket.emit('session-init', { compress: false, checksum: false }, ack2);

    expect(ack1).toHaveBeenCalledWith({ ok: true });
    expect(ack2).toHaveBeenCalledWith({ ok: true });

    // file-start should only be registered once (not doubled)
    const fileStartListeners = mockSocket.listenerCount('file-start');
    expect(fileStartListeners).toBe(1);
  });

  it('should call onConnection callback when provided', async () => {
    const onConnection = jest.fn();
    const { createServer } = require('../../server/server');
    const result = await createServer({ port: 8888, outputDir: '/tmp', onConnection });

    // Simulate a client connecting
    const mockSocket = new EventEmitter();
    mockSocket.id = 'test-socket-id';
    result.io.emit('connection', mockSocket);

    expect(onConnection).toHaveBeenCalledWith(mockSocket);
  });

  it('should handle transfer-complete event', async () => {
    const { createServer } = require('../../server/server');
    const result = await createServer({ port: 8888, outputDir: '/tmp' });

    const mockSocket = new EventEmitter();
    mockSocket.id = 'test-socket-id';
    result.io.emit('connection', mockSocket);

    const ack = jest.fn();
    mockSocket.emit('transfer-complete', { totalFiles: 5, totalBytes: 1024 }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: true });
  });
});
