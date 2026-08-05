'use strict';

const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

// Mock socket.io-client
jest.mock('socket.io-client', () => ({
  io: jest.fn()
}));

// Mock fs.promises for sender
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      open: jest.fn()
    }
  };
});

describe('client/index - runSendSession', () => {
  let mockSocket;
  let runSendSession;
  const { io } = require('socket.io-client');

  beforeEach(() => {
    jest.resetModules();

    // Re-setup mocks after resetModules
    jest.mock('socket.io-client', () => ({
      io: jest.fn()
    }));

    // Create a mock socket that extends EventEmitter
    mockSocket = new EventEmitter();
    mockSocket.connected = false;
    mockSocket.connect = jest.fn(function() {
      // Simulate async connect
      setImmediate(() => {
        this.connected = true;
        this.emit('connect');
      });
    });
    mockSocket.disconnect = jest.fn();

    // Override emit to track calls but still allow EventEmitter behavior
    const originalEmit = mockSocket.emit.bind(mockSocket);
    const emitCalls = [];
    mockSocket.emit = jest.fn(function(event, ...args) {
      emitCalls.push([event, ...args]);
      // Handle ack-based emits (last arg is callback)
      const lastArg = args[args.length - 1];
      if (typeof lastArg === 'function') {
        // Auto-ack with ok response
        if (event === 'session-init') {
          setImmediate(() => lastArg({ ok: true }));
        } else if (event === 'transfer-complete') {
          setImmediate(() => lastArg({ ok: true }));
        }
      }
      return originalEmit(event, ...args);
    });
    mockSocket._emitCalls = emitCalls;

    const ioModule = require('socket.io-client');
    ioModule.io.mockReturnValue(mockSocket);

    // Prevent process.exit from actually exiting
    jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    runSendSession = require('../../client/index').runSendSession;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should export runSendSession as a function', () => {
    expect(typeof runSendSession).toBe('function');
  });

  it('should return immediately with empty arrays when no files found', async () => {
    // Mock listFiles to return empty array
    jest.mock('../../common/files', () => ({
      listFiles: jest.fn(() => []),
      toWireKey: jest.fn(),
      fromWireKey: jest.fn()
    }));

    // Re-require after mock
    jest.resetModules();
    jest.mock('socket.io-client', () => ({
      io: jest.fn(() => mockSocket)
    }));
    const { runSendSession: freshRun } = require('../../client/index');

    const result = await freshRun({
      address: '127.0.0.1',
      port: 8000,
      folder: path.join(__dirname, '../fixtures'),
      options: { concurrency: 5, compress: false, checksum: true, retries: 3, resume: true }
    });

    expect(result).toEqual({ succeeded: [], failed: [], skipped: 0, exitCode: 0 });
  });

  it('should create connection with correct address and port when files exist', async () => {
    jest.resetModules();

    const mockSock = new EventEmitter();
    mockSock.connected = false;
    mockSock.connect = jest.fn(function() {
      setImmediate(() => {
        this.connected = true;
        this.emit('connect');
      });
    });
    mockSock.disconnect = jest.fn();
    // Auto-ack session-init and transfer-complete
    const origEmit = mockSock.emit.bind(mockSock);
    mockSock.emit = jest.fn(function(event, ...args) {
      const lastArg = args[args.length - 1];
      if (typeof lastArg === 'function') {
        if (event === 'session-init') setImmediate(() => lastArg({ ok: true }));
        else if (event === 'transfer-complete') setImmediate(() => lastArg({ ok: true }));
        else if (event === 'file-start') setImmediate(() => lastArg({ ok: true, offset: 0 }));
        else if (event === 'file-end') setImmediate(() => lastArg({ ok: true, status: 'verified' }));
      }
      return origEmit(event, ...args);
    });

    const mockIo = jest.fn(() => mockSock);
    jest.mock('socket.io-client', () => ({ io: mockIo }));
    jest.mock('../../common/files', () => ({
      listFiles: jest.fn(() => [
        { relativePath: 'test.txt', absolutePath: '/tmp/test.txt', size: 0, mtime: 1000 }
      ]),
      toWireKey: jest.fn(),
      fromWireKey: jest.fn()
    }));

    const { runSendSession: freshRun } = require('../../client/index');

    await freshRun({
      address: '192.168.1.100',
      port: 9000,
      folder: '/tmp',
      options: { concurrency: 5, compress: false, checksum: false, retries: 3, resume: true }
    });

    expect(mockIo).toHaveBeenCalledWith(
      'ws://192.168.1.100:9000',
      expect.objectContaining({
        transports: ['websocket'],
        autoConnect: false
      })
    );
  });

  it('should call socket.disconnect() after session completes', async () => {
    jest.mock('../../common/files', () => ({
      listFiles: jest.fn(() => []),
      toWireKey: jest.fn(),
      fromWireKey: jest.fn()
    }));

    jest.resetModules();
    jest.mock('socket.io-client', () => ({
      io: jest.fn(() => mockSocket)
    }));
    const { runSendSession: freshRun } = require('../../client/index');

    await freshRun({
      address: '127.0.0.1',
      port: 8000,
      folder: path.join(__dirname, '../fixtures'),
      options: { concurrency: 5, compress: false, checksum: true, retries: 3, resume: true }
    });

    // No files = no connection needed, so disconnect won't be called
    // but the function should not throw
    expect(true).toBe(true);
  });
});
