# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] - 2026-08-04

Major rewrite. Project renamed from `remote-copy` to `remote-sync`.

### Added

- Parallel file transfers with configurable concurrency (default: 5)
- Brotli compression support (optional, quality 3 for speed)
- MD5 checksum verification with automatic retry on mismatch
- Resume capability (skip already-transferred files)
- Session initialization protocol (session-init / session-ack)
- Resume protocol (resume-query / resume-response)
- File acknowledgment protocol (file-ack with ok/mismatch status)
- New CLI options: `-c` concurrency, `-z` compress, `--no-checksum`, `-r` retries, `--no-resume`
- Common utility modules: checksum.js, compression.js, concurrency.js
- Comprehensive test suite (41 unit tests with Jest)
- Performance benchmarks for Brotli compression
- Professional README.md documentation
- ARCHITECTURE.md design specification
- npm overrides to resolve audit vulnerabilities

### Changed

- Project renamed from `remote-copy` to `remote-sync`
- Dependencies updated to latest versions (commander ^15, socket.io ^4.8.3)
- Version bumped from 0.0.1 to 0.0.2
- Client rewritten for parallel streaming pipeline
- Server rewritten with decompression, verification, and resume support
- Node.js engine requirement: >=16.0.0

### Removed

- Unused `socket-io` dependency
- Unused `socket.io-server` dependency
- Sequential-only transfer limitation

### Fixed

- Typo "trasferred" corrected to "transferred"
- All npm audit vulnerabilities resolved (via overrides for socket.io-stream/debug)

### Security

- Added npm overrides to force `debug@^4.3.4` for socket.io-stream (resolves ReDoS vulnerabilities)
- 0 vulnerabilities in `npm audit`

## [0.0.1] - 2026-01-15

Initial release under the original project name `remote-copy`.

### Added

- Basic client-server file transfer over LAN using WebSockets
- Sequential file sending (one file at a time)
- Socket.IO + socket.io-stream for communication
- Commander.js CLI with `receive` and `send` commands
- Progress reporting during file transfer
- Recursive directory traversal and structure preservation
- Hardcoded port 8000

[0.0.2]: https://github.com/remote-sync/remote-sync/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/remote-sync/remote-sync/releases/tag/v0.0.1
