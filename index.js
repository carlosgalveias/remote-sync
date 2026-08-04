#!/usr/bin/env node
'use strict';
const { program } = require('commander');

program.version('0.0.1');

const startServer = () => {
  require('./server');
};

const startSync = (ip, folder, options) => {
  require('./client')(ip, folder, options);
};

program
  .command('receive')
  .description('start a server to receive data')
  .action(() => startServer());

program
  .command('send')
  .description('copy folder recursively to receiver')
  .option('-a, --address <ip>', 'ip address of the receiver', '127.0.0.1')
  .option('-f, --folder <folder>', 'folder to copy', process.cwd())
  .option('-c, --concurrency <number>', 'number of parallel file transfers', '5')
  .option('-z, --compress', 'enable Brotli compression')
  .option('--no-checksum', 'disable MD5 checksum verification')
  .option('-r, --retries <number>', 'max retries per file on checksum mismatch', '3')
  .option('--no-resume', 'disable resume capability')
  .action((options) => {
    startSync(options.address, options.folder, {
      concurrency: parseInt(options.concurrency, 10),
      compress: options.compress || false,
      checksum: options.checksum,
      retries: parseInt(options.retries, 10),
      resume: options.resume
    });
  });

program.parse(process.argv);
