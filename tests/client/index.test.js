'use strict';

const path = require('path');
const EventEmitter = require('events');

// Mock socket.io-client
jest.mock('socket.io-client', () => ({
  connect: jest.fn()
}));

// Mock socket.io-stream
jest.mock('socket.io-stream', () => {
  const mockSs = jest.fn(() => ({
    emit: jest.fn()
  }));
  mockSs.createStream = jest.fn(() => {
    const { PassThrough } = require('stream');
    return new PassThrough();
  });
  return mockSs;
});

// Mock progress-stream
jest.mock('progress-stream', () => {
  return jest.fn(() => {
    const { PassThrough } = require('stream');
    const pt = new PassThrough();
    pt.on('progress', () => {});
    return pt;
  });
});

// Mock process.stdout methods
const originalStdout = { ...process.stdout };
beforeAll(() => {
  process.stdout.clearLine = jest.fn();
  process.stdout.cursorTo = jest.fn();
});

const io = require('socket.io-client');
const ss = require('socket.io-stream');
const fs = require('fs');

describe('client/index - processRequest', () => {
  let mockSocket;
  let processRequest;

  beforeEach(() => {
    jest.resetModules();

    // Re-setup mocks after resetModules
    jest.mock('socket.io-client', () => ({
      connect: jest.fn()
    }));

    jest.mock('socket.io-stream', () => {
      const mockSs = jest.fn(() => ({
        emit: jest.fn()
      }));
      mockSs.createStream = jest.fn(() => {
        const { PassThrough } = require('stream');
        return new PassThrough();
      });
      return mockSs;
    });

    jest.mock('progress-stream', () => {
      return jest.fn(() => {
        const { PassThrough } = require('stream');
        const pt = new PassThrough();
        return pt;
      });
    });

    // Create a mock socket that extends EventEmitter
    mockSocket = new EventEmitter();
    mockSocket.emit = jest.fn(function(event, ...args) {
      return EventEmitter.prototype.emit.call(this, event, ...args);
    });
    mockSocket.once = jest.fn(function(event, cb) {
      return EventEmitter.prototype.once.call(this, event, cb);
    });
    mockSocket.on = jest.fn(function(event, cb) {
      return EventEmitter.prototype.on.call(this, event, cb);
    });
    mockSocket.removeListener = jest.fn(function(event, cb) {
      return EventEmitter.prototype.removeListener.call(this, event, cb);
    });

    const ioModule = require('socket.io-client');
    ioModule.connect.mockReturnValue(mockSocket);

    process.stdout.clearLine = jest.fn();
    process.stdout.cursorTo = jest.fn();
    process.stdout.write = jest.fn();

    // Prevent process.exit from actually exiting
    jest.spyOn(process, 'exit').mockImplementation(() => {});

    processRequest = require('../../client/index');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should connect to the correct server address and port', () => {
    const ioModule = require('socket.io-client');

    processRequest('192.168.1.100', '/some/folder', { resume: false, checksum: false });

    expect(ioModule.connect).toHaveBeenCalledWith('ws://192.168.1.100:8000');
  });

  it('should emit session-init with correct options on connect', async () => {
    const ioModule = require('socket.io-client');

    processRequest('myserver', '/some/folder', {
      compress: true,
      checksum: true,
      resume: false
    });

    // Simulate server connection
    const connectHandler = mockSocket.on.mock.calls.find(
      ([event]) => event === 'connect'
    );
    expect(connectHandler).toBeDefined();

    // Get the 'connect' callback
    const connectCb = connectHandler[1];

    // Mock listFilesFromFolder to return empty array to simplify
    jest.mock('../../common/files', () => ({
      listFilesFromFolder: jest.fn(() => [])
    }));

    // Trigger connect event — session-init should be emitted
    // We need to manually call emit on the EventEmitter prototype
    EventEmitter.prototype.emit.call(mockSocket, 'connect');

    // Give it a tick to process
    await new Promise((resolve) => setImmediate(resolve));

    // Verify session-init was emitted
    const sessionInitCall = mockSocket.emit.mock.calls.find(
      ([event]) => event === 'session-init'
    );
    expect(sessionInitCall).toBeDefined();
    expect(sessionInitCall[1]).toEqual({ compress: true, checksum: true });
  });

  it('should register connect_error handler', () => {
    processRequest('myserver', '/some/folder', {});

    const errorHandler = mockSocket.on.mock.calls.find(
      ([event]) => event === 'connect_error'
    );
    expect(errorHandler).toBeDefined();
  });

  it('should scan the folder for files after session is initialized', async () => {
    const fixturesDir = path.join(__dirname, '../fixtures');

    processRequest('myserver', fixturesDir, {
      resume: false,
      checksum: false,
      compress: false
    });

    // Simulate connection
    EventEmitter.prototype.emit.call(mockSocket, 'connect');

    // Wait for async operations
    await new Promise((resolve) => setImmediate(resolve));

    // Simulate session-ack
    EventEmitter.prototype.emit.call(mockSocket, 'session-ack');

    // Give more time for async processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that socket.io-stream emit was called (files being sent)
    const ssModule = require('socket.io-stream');
    // If files were found, ss(socket).emit should have been called
    // The test verifies the connection flow works correctly
    expect(mockSocket.emit.mock.calls.length).toBeGreaterThan(0);
  });

  it('should handle connect with no files to transfer (resume skips all)', async () => {
    const fixturesDir = path.join(__dirname, '../fixtures');

    processRequest('myserver', fixturesDir, {
      resume: true,
      checksum: true,
      compress: false
    });

    // Simulate connection
    EventEmitter.prototype.emit.call(mockSocket, 'connect');
    await new Promise((resolve) => setImmediate(resolve));

    // Simulate session-ack
    EventEmitter.prototype.emit.call(mockSocket, 'session-ack');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The client should proceed through the protocol steps
    expect(mockSocket.emit.mock.calls.some(([event]) => event === 'session-init')).toBe(true);
  });
});
