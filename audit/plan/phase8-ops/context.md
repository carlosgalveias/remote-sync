# Phase 8 — Ops Surface: Context

## Current CLI Implementation (`index.js`)

```js
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
```

**Problems addressed by Phase 8:**
- Version hardcoded to `'0.0.1'` (DEF-020) — should read from `package.json`
- No port option (ADD-001) — hardcoded to 8000
- No input validation (ADD-007) — `parseInt('banana')` = NaN = hang
- No timeout option
- No dry-run mode
- No verbose/quiet modes
- No log file option
- `receive` command takes no options at all

---

## Current `ARCHITECTURE.md` (To Be Rewritten)

The current ARCHITECTURE.md is a work of speculative fiction (see ADD-001 in the audit). It documents:
- `transferId` (doesn't exist)
- `transfer-complete` event (doesn't exist)
- `--compress-level` option (doesn't exist)
- `-p, --port` option (doesn't exist — but Phase 8 will implement it)
- `-o, --output` option (doesn't exist — but Phase 8 will implement it)
- Manifest batching in chunks of 500 (doesn't exist)
- `client/sender.js` (doesn't exist yet — Phase 4 creates it)
- `client/progress.js` (doesn't exist yet — Phase 7 creates it)
- `server/receiver.js` (doesn't exist yet — Phase 4 creates it)
- `ProgressReporter` class (doesn't exist yet — Phase 7 creates it)
- Exponential backoff on connection failure (doesn't exist — Phase 6 creates it)

The rewritten ARCHITECTURE.md must document ONLY what actually exists after all phases are complete.

---

## Target File Structure After All Phases

```
remote-sync/
├── index.js                    # CLI entry point (Commander)
├── package.json                # v1.0.0, no socket.io-stream or progress-stream
├── eslint.config.js            # ESLint flat config (Phase 8)
├── ARCHITECTURE.md             # Rewritten (Phase 8)
├── README.md                   # Updated (Phase 8)
├── CHANGELOG.md                # Updated
├── .gitignore
│
├── client/
│   ├── index.js                # Transfer orchestrator
│   ├── connection.js           # Socket.IO client wrapper + state machine
│   ├── sender.js               # Chunked file sender
│   ├── progress.js             # Progress renderer
│   ├── retry.js                # Exponential backoff utility
│   └── inflight.js             # In-flight transfer tracker
│
├── server/
│   ├── index.js                # Server entry (wires server.js + receiver.js)
│   ├── server.js               # Socket.IO server factory
│   ├── receiver.js             # Chunk reassembly + atomic write
│   └── state.js                # Server-side session/part tracking
│
├── common/
│   ├── protocol.js             # Shared constants + event names
│   ├── concurrency.js          # ConcurrencyPool with runAllSettled
│   ├── files.js                # File listing + path normalization
│   ├── checksum.js             # MD5 utilities (minor fix)
│   ├── compression.js          # Brotli compress/decompress (unchanged)
│   └── state.js                # Transfer state manifest (.remote-sync/state.json)
│
├── audit/
│   ├── AUDIT.md                # The deep audit (kept for history)
│   └── plan/                   # This plan (kept for history)
│       ├── PLAN.md
│       ├── phase4-core/
│       ├── phase5-resume/
│       ├── phase6-resilience/
│       ├── phase7-progress/
│       └── phase8-ops/
│
└── tests/
    ├── client/
    │   ├── index.test.js
    │   ├── sender.test.js
    │   ├── connection.test.js
    │   ├── progress.test.js
    │   ├── retry.test.js
    │   └── inflight.test.js
    ├── server/
    │   ├── index.test.js
    │   ├── receiver.test.js
    │   └── state.test.js
    ├── common/
    │   ├── protocol.test.js
    │   ├── concurrency.test.js
    │   ├── files.test.js
    │   ├── checksum.test.js
    │   ├── compression.test.js
    │   └── state.test.js
    ├── integration/
    │   ├── transfer.test.js    # Full end-to-end
    │   ├── resume.test.js      # Kill + restart
    │   └── resilience.test.js  # Network failure simulation
    ├── fixtures/
    │   ├── sample.txt
    │   └── nested/inner.txt
    └── performance/
        └── brotli-benchmark.js
```

---

## ESLint Flat Config Details

ESLint v9+ uses flat config (single `eslint.config.js` at project root). No `.eslintrc`, no `eslintIgnore` in `package.json`.

**DevDependencies to add:**
```json
{
  "eslint": "^9.0.0",
  "eslint-config-standard": "^17.0.0",
  "@eslint/js": "^9.0.0"
}
```

Note: `eslint-config-standard` v17+ may require peer deps. The implementer should check the exact requirements at implementation time. If `eslint-config-standard` doesn't support flat config yet, use `@eslint/js` recommended rules + hand-pick standard-style rules.

**Package.json scripts addition:**
```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "test": "jest --coverage",
    "test:watch": "jest --watch"
  }
}
```

---

## Dry-Run Implementation Detail

The dry-run mode must NOT require a running server. It performs only local operations:

```js
async function dryRun(folder, options) {
  // 1. List files
  const files = listFiles(folder);
  console.log(`[dry-run] Source: ${path.resolve(folder)}`);
  console.log(`[dry-run] Found ${files.length} file(s)\n`);

  // 2. Compute resume plan if resume enabled
  let plan = { skip: [], resume: [], pending: files.map(f => f.wireKey) };
  if (options.resume) {
    const state = loadState(folder);
    if (state) {
      plan = computeResumePlan(state, files);
    }
  }

  // 3. Print what would be transferred
  const toTransfer = [...plan.pending, ...plan.resume.map(r => r.wireKey)];
  const transferFiles = files.filter(f => toTransfer.includes(f.wireKey));
  const totalBytes = transferFiles.reduce((sum, f) => sum + f.size, 0);

  console.log(`[dry-run] Would transfer ${transferFiles.length} file(s) (${formatSize(totalBytes)}):`);

  // Show up to 50 files (or all if --verbose)
  const limit = options.verbose ? transferFiles.length : Math.min(50, transferFiles.length);
  for (let i = 0; i < limit; i++) {
    const f = transferFiles[i];
    console.log(`  ${f.wireKey.padEnd(50)} ${formatSize(f.size).padStart(10)}`);
  }
  if (transferFiles.length > limit) {
    console.log(`  ... and ${transferFiles.length - limit} more`);
  }

  // 4. Print skip summary
  if (plan.skip.length > 0) {
    console.log(`\n[dry-run] Would skip ${plan.skip.length} file(s) (already synced)`);
  }
  if (plan.resume.length > 0) {
    console.log(`[dry-run] Would resume ${plan.resume.length} file(s) from partial`);
  }

  console.log(`\n[dry-run] Total: ${transferFiles.length} files, ${formatSize(totalBytes)}`);
  process.exit(0);
}
```

---

## Verbose/Quiet Integration with ProgressRenderer

```js
// In client/index.js setup:
const progressOptions = {
  totalFiles: filesToSend.length,
  totalBytes: totalBytes
};

if (options.quiet) {
  // No progress renderer — suppress all output except errors
  progressOptions.stream = { write: () => {} };  // /dev/null
} else if (options.verbose) {
  // Progress renderer active, but also log debug messages
  // Debug messages go above progress line via progress.warn()
}

const progress = new ProgressRenderer(progressOptions);
```

---

## Log Levels

```
ERROR   → always shown, always logged
WARN    → shown unless --quiet, always logged
INFO    → shown in default mode, always logged
DEBUG   → shown only with --verbose, always logged
```

Implementation uses a numeric level:
```js
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const consoleLevel = options.quiet ? 0 : options.verbose ? 3 : 2;
// Log file always uses level 3 (debug)
```

---

## Audit Finding Addressed

| Finding | Description | How Fixed |
|---------|-------------|-----------|
| ADD-001 | ARCHITECTURE.md is fiction | Complete rewrite to match reality |
| ADD-007 | NaN concurrency hangs | All options validated before use |
| DEF-020 | Version mismatch | Read from package.json |

---

## ARCHITECTURE.md Rewrite Outline

The new ARCHITECTURE.md should document:

1. **System Overview** — What remote-sync does, single paragraph
2. **Architecture Diagram** — Client/Server with protocol messages
3. **Protocol Specification** — All events, payloads, ack formats
4. **File Structure** — Module responsibilities
5. **Transfer Lifecycle** — Step-by-step flow from CLI invocation to completion
6. **Resume Protocol** — How state is tracked, how resume decisions are made
7. **Resilience Model** — Connection states, retry policy, failure isolation
8. **Security Model** — Path validation, sandboxing
9. **Configuration** — All CLI options with defaults
10. **Limitations** — What it doesn't do (no encryption, no authentication, LAN only)

Maximum length: 500 lines. No speculative fiction. Every feature documented must have corresponding code with a file:line reference.
