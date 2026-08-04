# remote-copy

Copy entire folders to another machine

# Installation

1. Clone the repo 
2. Npm Install -g

# Usage

- Receiver Side

The receiver will receive the files from the sender and overwrite the files in the same place as the original files

Command: `remote-copy receiver`

- [x] Make sure your receiver does not block port 8000
- [x] Make sure you run the receiver as administrator

- Sender Side

The sender will transfer all files and folders recursively to the receiver

Command: `remote-copy send -a <ip address>`

- [x] Make sure you run this command in the root of the folder you want to send
- [x] make sure you are in a administrator powershell window
