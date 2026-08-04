'use strict';
const io = require('socket.io-client');
const ss = require('socket.io-stream');
const files = require('../common/files');
const progress = require('progress-stream');
const fs = require('fs')

const sendFile = function(file, socket) {
  return new Promise((resolve, reject) => {
    try {
      const stream = ss.createStream();
      ss(socket).emit('file', stream, { file });
      const stat = fs.statSync(file);
      const str = progress({
        length: stat.size,
        time: 100 /* ms */
      });
      console.log('uploading file:', file);
      str.on('progress', function(progress) {
        /*
        {
            percentage: 9.05,
            transferred: 949624,
            length: 10485760,
            remaining: 9536136,
            eta: 42,
            runtime: 3,
            delta: 295396,
            speed: 949624
        }
        */
        process.stdout.write(`${file} - ${Math.round(progress.percentage)}% eta:${progress.eta}                                      \r`);
      });
      const fstream = fs.createReadStream(file).pipe(str).pipe(stream);
      fstream.on('end', () => {
        console.log('file', file, 'trasferred');
        return resolve();
      });
      fstream.on('error', () => {
        console.log('could not send file', file);
        return resolve();
      });
    } catch (e) {
      console.error('error uploading file', file);
      console.error(e.message);
      return resolve();
    }
  });
};

const processList = async function(fileList, socket, stream) {
  for (const file of fileList) {
    if (file.type === 'file') {
      await sendFile(file.file, socket, stream);
    }
  }
  process.exit(0);
};

const connect = function(server) {
  server = server || '127.0.0.1';
  const socket = io.connect(`ws://${server}:8000`);
  return socket;
};

const processRequest = function(server, folder) {
  const socket = connect(server);
  console.log('socket', socket);
  const list = files.listFilesFromFolder(folder);
  processList(list, socket);
};

module.exports = processRequest;