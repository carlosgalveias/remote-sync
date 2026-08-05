# Phase 8 — Ops Surface: Requirements

## Scope

CLI polish, configuration options, developer tooling (ESLint), and documentation rewrite. This is the final phase — making the tool pleasant to use and maintain.

---

## Files to Create

| File | Purpose |
|------|---------|
| `eslint.config.js` | ESLint flat config (replaces .eslintrc) |

## Files to Modify

| File | Change |
|------|--------|
| `index.js` | Add all new CLI options: `-p/--port`, `--timeout`, `--dry-run`, `-v/--verbose`, `-q/--quiet`, `--log-file` |
| `client/index.js` | Implement dry-run mode, respect verbose/quiet, write log file |
| `server/server.js` | Accept port from caller (already designed in Phase 4, wired here) |
| `server/index.js` | Pass port from CLI to server factory |
| `package.json` | Add `eslint`, `eslint-config-standard` to devDeps, add `lint` script |
| `ARCHITECTURE.md` | Complete rewrite to match actual implementation |
| `README.md` | Update usage examples and feature list |

---

## Design Decisions

### 1. CLI Options (Final Interface)

```
remote-sync send [options]

Options:
  -a, --address <ip>          IP address of the receiver (default: "127.0.0.1")
  -p, --port <number>         Port number (default: "8000")
  -f, --folder <folder>       Folder to copy (default: CWD)
  -c, --concurrency <number>  Parallel file transfers (default: "5")
  -z, --compress              Enable Brotli compression
  --no-checksum               Disable MD5 checksum verification
  -r, --retries <number>      Max retries per file (default: "3")
  --no-resume                 Disable resume capability
  --timeout <seconds>         Per-file timeout in seconds (default: "300")
  --dry-run                   List files that would be transferred, then exit
  -v, --verbose               Show per-chunk debug information
  -q, --quiet                 Show only errors and final summary
  --log-file <path>           Write all output to a log file
  -V, --version               Output version number
  -h, --help                  Display help

remote-sync receive [options]

Options:
  -p, --port <number>         Port to listen on (default: "8000")
  -o, --output <dir>          Output directory (default: CWD)
  -v, --verbose               Show per-chunk debug information
  -q, --quiet                 Show only errors and final summary
  --log-file <path>           Write all output to a log file
  -V, --version               Output version number
  -h, --help                  Display help
```

### 2. Input Validation

All numeric options validated before use:

```js
function validatePort(value) {
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}. Must be 1-65535.`);
  }
  return port;
}

function validatePositiveInt(value, name) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) {
    throw new Error(`Invalid ${name}: ${value}. Must be a non-negative integer.`);
  }
  return n;
}

function validateConcurrency(value) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1 || n > 100) {
    throw new Error(`Invalid concurrency: ${value}. Must be 1-100.`);
  }
  return n;
}
```

### 3. Dry-Run Mode

`--dry-run` performs:
1. Scan source folder
2. Compute resume plan (if resume enabled)
3. Print file list that would be transferred (with sizes)
4. Print summary: total files, total bytes
5. Exit 0

No network connection made. No state modified.

Output format:
```
[dry-run] Would transfer 1,503 files (2.3 GB):
  src/index.js                    4.1 KB
  src/utils/helper.js             2.3 KB
  assets/logo.png                 1.0 MB
  ... (truncated to first 20 files in quiet mode)

  Total: 1,503 files, 2.3 GB
  Skipped (already synced): 47 files
```

### 4. Verbose / Quiet Modes

**Default:** Progress bar + file completion notices + warnings + errors + summary

**Verbose (`-v`):** Everything above PLUS:
- Per-chunk events: `[chunk] src/app.js #42/80 (128KB, 3ms ack)`
- Connection state changes: `[conn] state: connected → reconnecting`
- Resume decisions: `[resume] src/app.js: skip (unchanged, size=4096 mtime=T)`
- Timing: `[time] Checksum hash fast-forward: 500MB in 0.8s`

**Quiet (`-q`):** ONLY:
- Errors (to stderr)
- Final summary line (to stdout)
- `failed-files.json` location if failures occurred

### 5. Log File

`--log-file ./sync.log` writes ALL output (verbose level, regardless of `-v`/`-q` flags) to the specified file. This is independent of terminal verbosity — the log always gets everything.

Implementation:
```js
// In client/index.js setup:
const logger = {
  _logFd: options.logFile ? fs.openSync(options.logFile, 'a') : null,

  log(level, message) {
    const timestamp = new Date().toISOString();
    const formatted = `${timestamp} [${level}] ${message}`;

    // Log file: always write everything
    if (this._logFd) {
      fs.writeSync(this._logFd, formatted + '\n');
    }

    // Console: respect verbosity
    if (level === 'error') {
      process.stderr.write(formatted + '\n');
    } else if (options.quiet) {
      // Suppress non-error output
    } else if (level === 'debug' && !options.verbose) {
      // Suppress debug unless verbose
    } else {
      // Let progress renderer handle stdout
    }
  },

  close() {
    if (this._logFd) fs.closeSync(this._logFd);
  }
};
```

### 6. Per-File Timeout

`--timeout 60` means: if a single file's entire transfer takes longer than 60 seconds, abort it. This is the outer timeout — not per-chunk (that's the stall detection from Phase 6).

Default: 300s (5 minutes). Generous for large files over slow LAN.

Implementation: wrap `sendFile()` with `Promise.race` against a timeout:

```js
async function sendWithTimeout(socket, fileInfo, options) {
  const timeout = options.timeout * 1000;
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const result = await sendFile(socket, fileInfo, options, { signal: controller.signal });
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`FILE_TIMEOUT: ${fileInfo.wireKey} exceeded ${options.timeout}s`);
    }
    throw err;
  }
}
```

### 7. ESLint Configuration

Flat config (ESLint v9+):

```js
// eslint.config.js
const standard = require('eslint-config-standard');

module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      ...standard.rules,
      'no-console': 'off',  // CLI tool, console is intentional
      'semi': ['error', 'always'],
      'space-before-function-paren': ['error', 'never'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly'
      }
    }
  }
];
```

### 8. Server Output Directory

The receive command now accepts `-o, --output <dir>`:

```js
program
  .command('receive')
  .description('Start a server to receive data')
  .option('-p, --port <number>', 'port to listen on', '8000')
  .option('-o, --output <dir>', 'output directory', process.cwd())
  .option('-v, --verbose', 'show per-chunk debug information')
  .option('-q, --quiet', 'show only errors')
  .option('--log-file <path>', 'write all output to a log file')
  .action((options) => {
    startServer({
      port: validatePort(options.port),
      outputDir: path.resolve(options.output),
      verbose: options.verbose || false,
      quiet: options.quiet || false,
      logFile: options.logFile || null
    });
  });
```

---

## Interface Contracts

### Modified `index.js` CLI

```js
#!/usr/bin/env node
'use strict';
const { program } = require('commander');
const path = require('path');
const pkg = require('./package.json');

program.version(pkg.version);

program
  .command('receive')
  .description('Start a server to receive files')
  .option('-p, --port <number>', 'port to listen on', '8000')
  .option('-o, --output <dir>', 'output directory', process.cwd())
  .option('-v, --verbose', 'verbose output')
  .option('-q, --quiet', 'quiet output (errors only)')
  .option('--log-file <path>', 'log file path')
  .action((options) => startServer(options));

program
  .command('send')
  .description('Copy folder recursively to receiver')
  .option('-a, --address <ip>', 'receiver IP', '127.0.0.1')
  .option('-p, --port <number>', 'receiver port', '8000')
  .option('-f, --folder <folder>', 'folder to copy', process.cwd())
  .option('-c, --concurrency <number>', 'parallel transfers', '5')
  .option('-z, --compress', 'enable Brotli compression')
  .option('--no-checksum', 'disable MD5 verification')
  .option('-r, --retries <number>', 'max retries per file', '3')
  .option('--no-resume', 'disable resume')
  .option('--timeout <seconds>', 'per-file timeout', '300')
  .option('--dry-run', 'list files without transferring')
  .option('-v, --verbose', 'verbose output')
  .option('-q, --quiet', 'quiet output (errors only)')
  .option('--log-file <path>', 'log file path')
  .action((options) => startSync(options));

program.parse(process.argv);
```

---

## Acceptance Criteria

1. `remote-sync send -p 9000 -a 192.168.1.5` connects to port 9000
2. `remote-sync receive -p 9000 -o ./received` listens on 9000, writes to `./received/`
3. `remote-sync send --dry-run` lists files with sizes, exits 0, no network call
4. `remote-sync send -v` shows per-chunk timing info
5. `remote-sync send -q` shows only final summary + errors
6. `remote-sync send --log-file sync.log` creates log file with all debug output
7. `remote-sync send --timeout 60` aborts a file after 60s
8. `remote-sync send -c banana` shows error: "Invalid concurrency: banana"
9. `remote-sync send -p 99999` shows error: "Invalid port: 99999"
10. `npm run lint` passes with zero errors on entire codebase
11. `remote-sync --version` outputs correct version matching `package.json`
12. `ARCHITECTURE.md` accurately describes the implemented system (no fiction)
13. `README.md` has working usage examples for all major features

---

## Constraints

- **DO NOT** add runtime dependencies (eslint is devDep only)
- **DO NOT** make `-v` and `-q` compatible (mutually exclusive — error if both set)
- **DO NOT** log sensitive data (full absolute paths on sender machine are acceptable in logs but not in wire protocol)
- **DO NOT** require ESLint to run tests — it's a separate `lint` script
- **DO** keep Commander as the CLI framework (already a dependency)
- **DO** read version from `package.json` (single source of truth)
- **DO** validate all options before making network connections

---

## Dependencies

- **Phase 6 complete:** All features must exist to document and expose via CLI flags.
- **Phase 7 complete:** Progress renderer integration needed for verbose/quiet modes.
