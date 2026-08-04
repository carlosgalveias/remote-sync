'use strict';
const fs = require('fs');
const io = require('socket.io')();
io.listen(8000);
console.log('server listening to port 8000');
const ss = require('socket.io-stream');
const path = require('path');

io.on('connection', function(socket) {
  console.log('connection received');
  ss(socket).on('file', function(stream, fileData) {
    try {
      const filename = path.basename(fileData.file);
      const dir = path.dirname(fileData.file);
      fs.mkdirSync(dir, { recursive: true });
      process.stdout.write(`receiving: ${fileData.file}                                      \r`);
      const fstream = fs.createWriteStream(path.join(dir, filename));
      fstream.on('error', () => {
        console.log('could not create file', fileData.file);
      });
      stream.pipe(fstream);
      stream.on('error', () => {
        console.log('error receiving stream, check for corrupted file', fileData.file);
      });
    } catch (e) {
      console.error('error', e.message);
      console.error('Could not receive file', fileData.file);
    }
  });
});