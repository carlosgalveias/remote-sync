# Implementation Plan — remote-sync Rebuild

## Overview

This plan replaces a 627-line prototype with a production-grade file transfer tool. The rebuild addresses 22 defects (5 CRITICAL, 8 HIGH, 6 MEDIUM, 3 LOW) identified in the audit while preserving the existing user-facing CLI contract where it works correctly.

**Version target:** 1.0.0
**Node.js minimum:** 18.0.0 (for native `stream.pipeline` with AbortSignal, `crypto.hash`, stable `fs.promises`)

---

## Dependency Graph

```
Phase 4 (Core Protocol)
    │
    ├──► Phase 5 (Resume)
    │        │
    │        └──► Phase 6 (Resilience)
    │                  │
    │                  ├──► Phase 7 (Progress)
    │                  │
    │                  └──► Phase 8 (Ops Surface)
    │
    └──► Phase 7 (Progress) [can start after Phase 4 core is stable]
```

**Critical path:** Phase 4 → Phase 5 → Phase 6 → Phase 8
**Parallel lane:** Phase 7 can begin after Phase 4 lands (depends only on pool interface)

---

## What Is NOT Being Changed

These modules are architecturally sound and will be preserved (with minor interface adjustments):

| Module | Verdict | Notes |
|--------|---------|-------|
| `common/compression.js` | **KEEP** | Brotli at quality 3 is correct for LAN. Interface stays the same. |
| `common/checksum.js` | **KEEP** (minor fix) | `computeFileChecksum` is fine. `createHashStream` needs a guard on double-digest. Will add `xxhash` option later but MD5 stays for now. |
| `tests/` structure | **KEEP** | Jest config stays. Test files will be rewritten to match new interfaces. |
| Commander CLI structure | **KEEP** | `index.js` stays as the CLI entry point. Options will be extended. |

---

## Implementation Phases

### Phase 4 — Core Protocol Rewrite

**Scope:** Replace the entire transfer protocol. This is the nuclear option: `client/index.js` and `server/index.js` are rewritten from scratch. `common/concurrency.js` and `common/files.js` are rewritten. `socket.io-stream` and `progress-stream` are removed.

**Files created:**
- `client/sender.js` — File chunking and sending logic
- `client/connection.js` — Socket.IO client wrapper with reconnection
- `server/receiver.js` — Chunk reassembly and atomic write
- `server/server.js` — Socket.IO server factory (configurable, testable)
- `common/concurrency.js` — Rewritten pool with isolation + callbacks
- `common/files.js` — Rewritten with relative path normalization
- `common/protocol.js` — Shared constants (event names, chunk size, message schemas)

**Files modified:**
- `client/index.js` — Rewritten orchestrator
- `server/index.js` — Rewritten to use `server/server.js` factory
- `index.js` — Minor: version fix, port option added
- `package.json` — Remove `socket.io-stream`, `progress-stream`; bump Node engine to >=18

**Files deleted:**
- None (old files are overwritten)

**Defects fixed:** DEF-001, DEF-002, DEF-003, DEF-004, DEF-005, DEF-008, DEF-009, DEF-012, DEF-013, DEF-014, DEF-015, DEF-016, DEF-019, DEF-020, DEF-022, ADD-002, ADD-005, ADD-006, ADD-007

**Acceptance criteria:**
1. Transfer a 1GB file in chunks without memory exceeding 200MB RSS
2. Transfer 10,000 small files (1KB each) without timeout or buffer overflow
3. Interrupted transfer leaves only `.part` files, never corrupt final files
4. Paths on the wire are POSIX-relative; receiver writes to CWD-relative paths
5. No `socket.io-stream` or `progress-stream` in `node_modules`
6. `--no-checksum` still works (skips hashing entirely)
7. Compression applies per-chunk (independent decompression)
8. Server rejects paths containing `..` or absolute paths

**Risk:** This is the largest phase. Everything depends on it. Must be integration-tested before proceeding.

---

### Phase 5 — Resume Rebuild

**Scope:** Persistent state tracking and byte-offset resume for interrupted transfers.

**Files created:**
- `common/state.js` — State manifest read/write (`.remote-sync/state.json`)
- `server/state.js` — Server-side state (tracks `.part` file sizes)

**Files modified:**
- `client/sender.js` — Add `start` offset to `createReadStream`
- `server/receiver.js` — Report `.part` sizes in `resume-response`
- `common/protocol.js` — Add `resume-query` / `resume-response` message schemas

**Defects fixed:** DEF-006, DEF-007, DEF-010, DEF-017

**Acceptance criteria:**
1. Kill transfer at 50% of a 100MB file → restart → completes from byte offset
2. `.remote-sync/state.json` written atomically (rename pattern)
3. Stale `.part` files from dead sessions detected via session ID mismatch
4. Resume query uses size+mtime first pass; checksums only for size-matched files
5. Transfer of 10,000 files with resume enabled completes in <2x non-resume time

**Risk:** State file corruption on crash. Mitigated by atomic writes + JSON schema validation on read.

**Dependencies:** Phase 4 complete.

---

### Phase 6 — Resilience

**Scope:** Per-file failure isolation, bounded retries, automatic reconnection, stall detection, graceful shutdown.

**Files created:**
- `client/retry.js` — Exponential backoff + jitter calculator
- `client/inflight.js` — In-flight transfer tracker (Map of fileKey → {offset, attempt})

**Files modified:**
- `client/connection.js` — Add reconnection state machine (connecting/connected/reconnecting/dead)
- `client/sender.js` — Integrate retry wrapper, stall detection timeout
- `client/index.js` — SIGINT handler, final report generation
- `common/concurrency.js` — Add `onTaskError` callback, `runAllSettled` method

**Defects fixed:** DEF-002, DEF-003, DEF-011, DEF-014 (reinforced)

**Acceptance criteria:**
1. Kill server mid-transfer → client reconnects within 5s → resumes in-flight files
2. One file with permission denied → all other files still transfer → exit code 1 + `failed-files.json`
3. Stall detection: if no `file-chunk-ack` for 30s → abort file → retry
4. Ctrl+C → writes state to `.remote-sync/state.json` → next run resumes
5. After max retries (3) per file, file is marked failed, transfer continues
6. Exponential backoff: 1s, 2s, 4s base with ±25% jitter

**Risk:** Complex state machine. Must be tested with simulated network failures.

**Dependencies:** Phase 4 + Phase 5 complete.

---

### Phase 7 — Single-line Progress Renderer

**Scope:** Isolated progress display module. Zero coupling to transfer logic.

**Files created:**
- `client/progress.js` — Progress renderer class

**Files modified:**
- `client/index.js` — Wire progress events from pool/sender to renderer

**Defects fixed:** ADD-002

**Acceptance criteria:**
1. Single self-updating line: `[████████░░░░] 847/2,103 files | 12.4 MB/s | ETA 3m22s`
2. Non-TTY: one line per completed file (no ANSI escapes)
3. Redraws throttled to max 10/s (100ms minimum interval)
4. Warning/error messages print ABOVE the progress line (line preserved)
5. Unit-testable with mock writable stream (no real stdout dependency)
6. Speed uses EWMA (α=0.3) over last 10 samples

**Risk:** Low. Isolated module.

**Dependencies:** Phase 4 (needs pool event interface). Can develop in parallel with Phase 5/6.

---

### Phase 8 — Ops Surface

**Scope:** CLI polish, configuration options, developer tooling.

**Files modified:**
- `index.js` — Add `-p/--port`, `--timeout`, `--dry-run`, `-v/--verbose`, `-q/--quiet`, `--log-file`
- `client/index.js` — Dry-run mode (list files, don't transfer)
- `server/server.js` — Accept port from CLI
- `package.json` — Add `eslint` + `eslint-config-standard` as devDeps, add `lint` script
- `.eslintrc.js` → `eslint.config.js` — Flat config ESLint

**Files created:**
- `eslint.config.js` — ESLint flat config

**Defects fixed:** ADD-001 (ARCHITECTURE.md rewrite triggered here)

**Acceptance criteria:**
1. `remote-sync send -p 9000` uses port 9000
2. `--dry-run` lists files that WOULD be transferred, exits 0
3. `--verbose` shows per-chunk debug info; `--quiet` shows only errors + final summary
4. `--log-file ./sync.log` writes all output to file
5. `--timeout 60` sets per-file timeout in seconds (default: 300)
6. `npm run lint` passes with zero errors on the entire codebase
7. ARCHITECTURE.md rewritten to match actual implementation

**Risk:** Low. Mostly CLI wiring.

**Dependencies:** Phase 6 complete (needs all features to document/expose).

---

## Removed Dependencies

| Package | Reason |
|---------|--------|
| `socket.io-stream` | Unmaintained since 2016, incompatible with Socket.IO v4 internals, root cause of DEF-019 |
| `progress-stream` | Replaced by internal progress module; was causing TTY crashes (ADD-002) |

## Added Dependencies (Production)

**None.** The rebuild uses only Node.js built-ins + `socket.io` + `socket.io-client` + `commander`.

## Added Dependencies (Development)

| Package | Justification |
|---------|---------------|
| `eslint` | Code quality gate (Phase 8) |
| `eslint-config-standard` | Consistent style without bikeshedding |

---

## Testing Strategy

Each phase includes its own test suite. Tests are written AFTER the implementation of each phase lands (test-after, not TDD — this is a rewrite, not greenfield).

- **Phase 4:** Integration tests with real Socket.IO (localhost). Test: single file, many files, large file, compression, checksum, path normalization, security rejection.
- **Phase 5:** Integration tests for resume. Test: kill-and-resume, stale part cleanup, manifest persistence.
- **Phase 6:** Integration tests with simulated failures. Test: network drop (close socket), permission denied, stall (server stops acking).
- **Phase 7:** Unit tests with mock stream. Test: format output, EWMA calculation, throttling, non-TTY fallback.
- **Phase 8:** CLI integration tests. Test: all flags parsed correctly, dry-run output, log file written.

---

## Timeline Estimate

| Phase | Effort | Blocking? |
|-------|--------|-----------|
| Phase 4 | 3-4 days | Yes — everything depends on this |
| Phase 5 | 1-2 days | Yes — Phase 6 depends on it |
| Phase 6 | 2-3 days | Yes — Phase 8 depends on it |
| Phase 7 | 0.5-1 day | No — parallel |
| Phase 8 | 0.5-1 day | No — final polish |

**Total:** 7-11 days elapsed for a single developer.
