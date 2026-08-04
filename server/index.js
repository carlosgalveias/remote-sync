'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const server = require('socket.io')(8000);
const ss = require('socket.io-stream');
const { computeFileChecksum, createHashStream } = require('../common/checksum');
const { createDecompressStream } = require('../common/compression');

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ name, address: iface.address });
      }
    }
  }
  return addresses;
}

console.log('Server listening on port 8000');
console.log('Available on:');
console.log('  localhost: 127.0.0.1');
const localIPs = getLocalIPs();
for (const { name, address } of localIPs) {
  console.log(`  ${name}: ${address}`);
}
console.log('\nWaiting for connections...');

server.on('connection', (socket) => {
  console.log('Client connected');

  let sessionOptions = { compress: false, checksum: false };

  socket.on('session-init', (options, cb) => {
    sessionOptions.compress = !!options.compress;
    sessionOptions.checksum = !!options.checksum;
    const ack = { ok: true };
    if (typeof cb === 'function') {
      cb(ack);
    } else {
      socket.emit('session-ack', ack);
    }
  });

  socket.on('resume-query', async (manifest, cb) => {
    const skip = [];
    const transfer = [];

    await Promise.all(manifest.map(async (entry) => {
      try {
        await fs.promises.access(entry.file, fs.constants.F_OK);
        const diskChecksum = await computeFileChecksum(entry.file);
        if (diskChecksum === entry.checksum) {
          skip.push(entry.file);
        } else {
          transfer.push(entry.file);
        }
      } catch (err) {
        transfer.push(entry.file);
      }
    }));

    const response = { skip, transfer };
    if (typeof cb === 'function') {
      cb(response);
    } else {
      socket.emit('resume-response', response);
    }
  });

  ss(socket).on('file', (stream, fileData) => {
    const filename = path.basename(fileData.file);
    const dir = path.dirname(fileData.file);
    console.log('Receiving file: ', filename);

    fs.mkdirSync(dir, { recursive: true });

    const writeStream = fs.createWriteStream(fileData.file);
    const compressed = !!fileData.compressed;
    const expectedChecksum = fileData.checksum || null;

    let pipeline = stream;
    let hashStream = null;

    if (compressed) {
      const decompressStream = createDecompressStream();
      pipeline.on('error', (err) => {
        console.error('Stream error: ', err);
      });
      pipeline = pipeline.pipe(decompressStream);
      decompressStream.on('error', (err) => {
        console.error('Decompression error: ', err);
      });
    }

    if (expectedChecksum) {
      hashStream = createHashStream();
      pipeline = pipeline.pipe(hashStream);
      hashStream.on('error', (err) => {
        console.error('Hash stream error: ', err);
      });
    }

    pipeline.pipe(writeStream);

    stream.on('error', (err) => {
      console.error('Stream error: ', err);
    });

    writeStream.on('error', (err) => {
      console.error('Write error: ', err);
    });

    writeStream.on('finish', () => {
      if (expectedChecksum && hashStream) {
        const receivedChecksum = hashStream.getHash();
        if (receivedChecksum === expectedChecksum) {
          socket.emit('file-ack', {
            file: fileData.file,
            status: 'ok',
            expected: expectedChecksum,
            received: receivedChecksum
          });
        } else {
          fs.unlink(fileData.file, (unlinkErr) => {
            if (unlinkErr) {
              console.error('Failed to delete mismatched file: ', unlinkErr);
            }
          });
          socket.emit('file-ack', {
            file: fileData.file,
            status: 'mismatch',
            expected: expectedChecksum,
            received: receivedChecksum
          });
        }
      } else {
        socket.emit('file-ack', {
          file: fileData.file,
          status: 'ok',
          expected: expectedChecksum,
          received: null
        });
      }
    });
  });
});
