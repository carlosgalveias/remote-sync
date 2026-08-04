#!node

const { Command } = require('commander');
const program = new Command();

const startServer = function() {
  require('./server');
};

const startSync = function(ip, folder) {
  const client = require('./client');
  client(ip, folder);
};

program
  .name('remote-copy')
  .description('CLI transfer files between computers using websockets and streams')
  .version('0.0.1');

program.command('receive')
  .description('start receiver server at port 8000')
  .action(() => {
    startServer();
  });

program.command('send')
  .description('copy folder to receiver, make sure receiver is running on destination machine and firewall is open on port 8000')
  .option('-a, --address <ip>', 'ip address (defaults to 127.0.0.1)', '127.0.0.1')
  .option('-f,--folder <folder>', 'Folder to Send (defaults to folder where command is run)', process.cwd())
  .action((opt) => {
    startSync(opt.address, opt.folder);
  });

program.parse();