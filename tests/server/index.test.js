'use strict';

let mockIoServer;
let mockConnectionHandler;

jest.mock('socket.io', () => {
  const { EventEmitter } = require('events');
  return jest.fn((port) => {
    mockIoServer = new EventEmitter();
    mockIoServer.port = port;
    const originalOn = mockIoServer.on.bind(mockIoServer);
    mockIoServer.on = jest.fn(function(event, cb) {
      if (event === 'connection') {
        mockConnectionHandler = cb;
      }
      return originalOn(event, cb);
    });
    return mockIoServer;
  });
});

jest.mock('socket.io-stream', () => {
  const { PassThrough } = require('stream');
  const { EventEmitter } = require('events');
  const mockSs = jest.fn((socket) => {
    const emitter = new EventEmitter();
    socket._ssEmitter = emitter;
    return emitter;
  });
  mockSs.createStream = jest.fn(() => new PassThrough());
  return mockSs;
});

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  const { PassThrough } = require('stream');
  return {
    ...actualFs,
    mkdirSync: jest.fn(),
    createWriteStream: jest.fn(() => {
      const ws = new PassThrough();
      ws.path = '/mock/path';
      // Simulate 'finish' event when stream ends
      const originalEnd = ws.end.bind(ws);
      ws.end = function(...args) {
        originalEnd(...args);
        setImmediate(() => ws.emit('finish'));
      };
      return ws;
    }),
    unlink: jest.fn((filePath, cb) => cb(null)),
    promises: {
      access: jest.fn()
    },
    constants: actualFs.constants
  };
});

jest.mock('../../common/checksum', () => {
  const { Transform } = require('stream');
  return {
    computeFileChecksum: jest.fn(() => Promise.resolve('abc123')),
    createHashStream: jest.fn(() => {
      const transform = new Transform({
        transform(chunk, enc, cb) {
          this.push(chunk);
          cb();
        }
      });
      transform.getHash = jest.fn(() => 'abc123');
      return transform;
    })
  };
});

jest.mock('../../common/compression', () => {
  const { PassThrough } = require('stream');
  return {
    createDecompressStream: jest.fn(() => new PassThrough())
  };
});

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

describe('server/index', () => {
  let mockServerSocket;

  beforeEach(() => {
    mockServerSocket = new EventEmitter();
    const originalEmit = mockServerSocket.emit.bind(mockServerSocket);
    mockServerSocket.emit = jest.fn(function(event, ...args) {
      return originalEmit(event, ...args);
    });
  });

  it('should create a Socket.IO server on port 8000', () => {
    require('../../server/index');
    const socketIo = require('socket.io');
    expect(socketIo).toHaveBeenCalledWith(8000);
  });

  it('should listen for connections', () => {
    expect(mockIoServer.on).toHaveBeenCalledWith('connection', expect.any(Function));
  });

  it('should handle session-init and respond with session-ack', () => {
    // Simulate a client connecting
    mockConnectionHandler(mockServerSocket);

    // Get the session-init handler
    const sessionInitHandler = mockServerSocket.listeners('session-init')[0];
    expect(sessionInitHandler).toBeDefined();

    // Call session-init with options
    sessionInitHandler({ compress: true, checksum: true });

    // Verify session-ack was emitted
    expect(mockServerSocket.emit).toHaveBeenCalledWith('session-ack', { ok: true });
  });

  it('should handle session-init with callback', () => {
    mockConnectionHandler(mockServerSocket);

    const sessionInitHandler = mockServerSocket.listeners('session-init')[0];
    const callback = jest.fn();

    sessionInitHandler({ compress: false, checksum: true }, callback);

    expect(callback).toHaveBeenCalledWith({ ok: true });
  });

  it('should handle resume-query and respond with resume-response', async () => {
    const { computeFileChecksum } = require('../../common/checksum');
    const fs = require('fs');

    mockConnectionHandler(mockServerSocket);

    const resumeHandler = mockServerSocket.listeners('resume-query')[0];
    expect(resumeHandler).toBeDefined();

    // Mock: file exists and checksum matches for file1, doesn't match for file2
    fs.promises.access.mockResolvedValue(undefined);
    computeFileChecksum
      .mockResolvedValueOnce('matching-checksum')
      .mockResolvedValueOnce('actual-checksum-on-disk');

    const manifest = [
      { file: '/path/to/file1.txt', checksum: 'matching-checksum' },
      { file: '/path/to/file2.txt', checksum: 'different-checksum' }
    ];

    await resumeHandler(manifest);

    // Verify resume-response was emitted
    expect(mockServerSocket.emit).toHaveBeenCalledWith(
      'resume-response',
      expect.objectContaining({
        skip: expect.any(Array),
        transfer: expect.any(Array)
      })
    );
  });

  it('should handle resume-query with callback', async () => {
    const { computeFileChecksum } = require('../../common/checksum');
    const fs = require('fs');

    mockConnectionHandler(mockServerSocket);

    const resumeHandler = mockServerSocket.listeners('resume-query')[0];

    fs.promises.access.mockResolvedValue(undefined);
    computeFileChecksum.mockResolvedValue('checksum1');

    const manifest = [{ file: '/path/file.txt', checksum: 'checksum1' }];
    const callback = jest.fn();

    await resumeHandler(manifest, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: expect.arrayContaining(['/path/file.txt']),
        transfer: []
      })
    );
  });

  it('should handle resume-query when file does not exist on disk', async () => {
    const fs = require('fs');

    mockConnectionHandler(mockServerSocket);

    const resumeHandler = mockServerSocket.listeners('resume-query')[0];

    // File doesn't exist
    fs.promises.access.mockRejectedValue(new Error('ENOENT'));

    const manifest = [{ file: '/path/missing.txt', checksum: 'some-checksum' }];

    await resumeHandler(manifest);

    expect(mockServerSocket.emit).toHaveBeenCalledWith(
      'resume-response',
      expect.objectContaining({
        skip: [],
        transfer: ['/path/missing.txt']
      })
    );
  });

  it('should handle file events and write files to disk', (done) => {
    const fs = require('fs');
    const ss = require('socket.io-stream');

    mockConnectionHandler(mockServerSocket);

    // Get the socket.io-stream emitter for this socket
    const ssEmitter = mockServerSocket._ssEmitter;
    expect(ssEmitter).toBeDefined();

    // Create a mock incoming stream
    const incomingStream = new PassThrough();
    const fileData = {
      file: '/output/test-file.txt',
      compressed: false,
      checksum: null
    };

    // Trigger the 'file' event on ss(socket)
    ssEmitter.emit('file', incomingStream, fileData);

    // Verify mkdirSync was called
    expect(fs.mkdirSync).toHaveBeenCalledWith('/output', { recursive: true });

    // Verify createWriteStream was called
    expect(fs.createWriteStream).toHaveBeenCalledWith('/output/test-file.txt');

    // Send data through the stream
    incomingStream.end('file content here');

    // Give time for the stream to finish
    setTimeout(() => {
      // file-ack should be emitted since no checksum was expected
      expect(mockServerSocket.emit).toHaveBeenCalledWith('file-ack', expect.objectContaining({
        file: '/output/test-file.txt',
        status: 'ok'
      }));
      done();
    }, 50);
  });

  it('should verify checksums and emit file-ack with ok status on match', (done) => {
    const { createHashStream } = require('../../common/checksum');
    const { Transform } = require('stream');

    // Setup createHashStream to return matching hash
    createHashStream.mockReturnValue((() => {
      const t = new Transform({
        transform(chunk, enc, cb) { this.push(chunk); cb(); }
      });
      t.getHash = () => 'expected-hash';
      return t;
    })());

    mockConnectionHandler(mockServerSocket);

    const ssEmitter = mockServerSocket._ssEmitter;
    const incomingStream = new PassThrough();

    const fileData = {
      file: '/output/verified.txt',
      compressed: false,
      checksum: 'expected-hash'
    };

    ssEmitter.emit('file', incomingStream, fileData);
    incomingStream.end('verified content');

    setTimeout(() => {
      expect(mockServerSocket.emit).toHaveBeenCalledWith('file-ack', expect.objectContaining({
        file: '/output/verified.txt',
        status: 'ok',
        expected: 'expected-hash',
        received: 'expected-hash'
      }));
      done();
    }, 50);
  });

  it('should emit file-ack with mismatch status on checksum failure', (done) => {
    const fs = require('fs');
    const { createHashStream } = require('../../common/checksum');
    const { Transform } = require('stream');

    // Setup createHashStream to return non-matching hash
    createHashStream.mockReturnValue((() => {
      const t = new Transform({
        transform(chunk, enc, cb) { this.push(chunk); cb(); }
      });
      t.getHash = () => 'wrong-hash';
      return t;
    })());

    mockConnectionHandler(mockServerSocket);

    const ssEmitter = mockServerSocket._ssEmitter;
    const incomingStream = new PassThrough();

    const fileData = {
      file: '/output/bad-file.txt',
      compressed: false,
      checksum: 'expected-hash'
    };

    ssEmitter.emit('file', incomingStream, fileData);
    incomingStream.end('corrupted content');

    setTimeout(() => {
      expect(mockServerSocket.emit).toHaveBeenCalledWith('file-ack', expect.objectContaining({
        file: '/output/bad-file.txt',
        status: 'mismatch',
        expected: 'expected-hash',
        received: 'wrong-hash'
      }));
      // Verify unlink was called to clean up the bad file
      expect(fs.unlink).toHaveBeenCalledWith('/output/bad-file.txt', expect.any(Function));
      done();
    }, 50);
  });
});
