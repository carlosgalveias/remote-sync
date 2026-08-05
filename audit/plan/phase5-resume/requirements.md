# Phase 5 — Resume Rebuild: Requirements

## Scope

Implement persistent state tracking and byte-offset resume for interrupted transfers. The resume system allows a killed transfer to restart from where it left off — at chunk granularity for large files, and at file granularity for the batch.

---

## Files to Create

| File | Purpose |
|------|---------|
| `common/state.js` | State manifest read/write/update for `.remote-sync/state.json` |
| `server/state.js` | Server-side `.part` file inventory and session tracking |

## Files to Modify

| File | Change |
|------|--------|
| `client/sender.js` | Accept `startOffset` from `file-start` ack; hash skipped bytes for resume |
| `client/index.js` | Load/save state manifest; filter already-completed files |
| `server/receiver.js` | Report `.part` sizes in `file-start` ack; support append mode |
| `common/protocol.js` | Add `resume-query` / `resume-response` event schemas |

---

## Design Decisions

### 1. Resume Manifest Format (`.remote-sync/state.json`)

Stored in the **sender's** source folder as `.remote-sync/state.json`:

```json
{
  "version": 1,
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "destination": "192.168.1.50:8000",
  "sourceFolder": "/home/alice/project",
  "startedAt": "2024-01-15T10:30:00.000Z",
  "files": {
    "src/index.js": {
      "size": 4096,
      "mtime": 1720000000000,
      "status": "completed",
      "md5": "a1b2c3d4e5f67890abcdef1234567890"
    },
    "assets/logo.png": {
      "size": 1048576,
      "mtime": 1720000000000,
      "status": "in-progress",
      "bytesSent": 524288,
      "lastChunkIndex": 3
    },
    "docs/readme.md": {
      "size": 2048,
      "mtime": 1720000000000,
      "status": "pending"
    }
  }
}
```

**Why store on sender side?**
- The sender drives the transfer. It knows which files it intended to send.
- The receiver may serve multiple senders — each sender's state is independent.
- The sender can detect file changes (mtime/size) since last attempt.

### 2. Resume Decision Algorithm (First Pass: Cheap)

Before transferring, the sender performs a **local-only** first pass:

```
for each file in sourceFolder:
  stateEntry = state.files[wireKey]

  if stateEntry is null:
    // New file, not in previous state → must transfer
    mark as 'pending'

  else if stateEntry.status === 'completed':
    if file.size === stateEntry.size AND file.mtime === stateEntry.mtime:
      // File unchanged since last successful transfer → SKIP
      mark as 'skip'
    else:
      // File changed since completion → re-transfer from scratch
      mark as 'pending'

  else if stateEntry.status === 'in-progress':
    if file.size === stateEntry.size AND file.mtime === stateEntry.mtime:
      // File unchanged, was partially sent → RESUME from bytesSent
      mark as 'resume', offset = stateEntry.bytesSent
    else:
      // File changed during partial → re-transfer from scratch
      mark as 'pending'
```

**No full-tree hashing required for the common case.** Size+mtime is sufficient to detect changes. Checksums are only computed during actual transfer (incremental).

### 3. Byte-Offset Resume Protocol

When the sender emits `file-start` with a known offset from state:

```js
// file-start payload includes hint:
{
  fileKey: 'assets/logo.png',
  size: 1048576,
  mtime: 1720000000000,
  compressed: true,
  checksum: true,
  resumeOffset: 524288  // "I think I sent this many bytes last time"
}
```

The **receiver** validates:
1. Does `<fileKey>.part` exist?
2. Is its size === `resumeOffset`?
3. Does the session ID match the `.part` file's creator?

If all yes → ack with `{ ok: true, offset: 524288 }`
If `.part` doesn't exist or size doesn't match → ack with `{ ok: true, offset: 0 }` (start fresh)
If session ID mismatch (stale `.part` from dead session) → delete stale `.part`, ack with `{ ok: true, offset: 0 }`

### 4. Sender Resume: Hashing the Skipped Portion

When resuming from offset > 0, the sender must still compute the full-file MD5 (for end-of-file verification). This means reading the already-sent bytes through the hash without re-sending them:

```
if offset > 0 AND checksum enabled:
  // Fast-forward hash through already-sent portion
  fd = fs.openSync(absolutePath, 'r')
  buffer = Buffer.allocUnsafe(CHUNK_SIZE)
  hashOffset = 0
  while hashOffset < offset:
    n = fs.readSync(fd, buffer, 0, Math.min(CHUNK_SIZE, offset - hashOffset), hashOffset)
    hash.update(buffer.slice(0, n))
    hashOffset += n
  // Now continue reading + hashing + sending from offset
```

This costs one local read pass of the already-sent portion, but no network I/O. For a 1GB file resumed at 500MB, this is 500MB of local read — fast on any modern disk (< 2s on SSD, < 10s on HDD).

### 5. Server-Side Session Tracking

The server tracks which session created each `.part` file to detect stale partials:

File: `<outputDir>/.remote-sync/sessions.json`

```json
{
  "parts": {
    "src/large-file.bin.part": {
      "sessionId": "550e8400-e29b-41d4-a716-446655440000",
      "lastActivity": "2024-01-15T10:35:00.000Z",
      "expectedSize": 1048576
    }
  }
}
```

On `file-start`:
- If `.part` exists and session ID matches → resume
- If `.part` exists and session ID differs → stale, delete and start fresh
- If no `.part` → start fresh

### 6. State File Atomicity

Both client and server state files are written atomically:
1. Write to `state.json.tmp`
2. `fsync` the fd
3. Rename `state.json.tmp` → `state.json`

On read: if `state.json` doesn't exist but `state.json.tmp` does, the last write crashed mid-way. Delete `.tmp` and start fresh.

---

## Interface Contracts

### `common/state.js`

```js
/**
 * @typedef {Object} FileState
 * @property {number} size - File size at time of state creation
 * @property {number} mtime - File mtime (Unix ms) at time of state creation
 * @property {'pending'|'in-progress'|'completed'|'failed'} status
 * @property {string} [md5] - Present only when status === 'completed'
 * @property {number} [bytesSent] - Present when status === 'in-progress'
 * @property {number} [lastChunkIndex] - Present when status === 'in-progress'
 */

/**
 * @typedef {Object} TransferState
 * @property {number} version - Schema version (always 1)
 * @property {string} sessionId
 * @property {string} destination - 'host:port'
 * @property {string} sourceFolder - Absolute path to source
 * @property {string} startedAt - ISO 8601
 * @property {Object<string, FileState>} files - Keyed by wireKey
 */

/**
 * Load state from disk. Returns null if no state exists.
 * @param {string} sourceFolder - The folder being sent
 * @returns {TransferState|null}
 */
function loadState(sourceFolder) { ... }

/**
 * Save state atomically to disk.
 * @param {string} sourceFolder
 * @param {TransferState} state
 */
function saveState(sourceFolder, state) { ... }

/**
 * Update a single file's status in state (read-modify-write, atomic).
 * @param {string} sourceFolder
 * @param {string} wireKey
 * @param {Partial<FileState>} update
 */
function updateFileState(sourceFolder, wireKey, update) { ... }

/**
 * Create fresh state for a new transfer.
 * @param {string} sourceFolder
 * @param {string} destination - 'host:port'
 * @param {Array<{wireKey: string, size: number, mtime: number}>} files
 * @returns {TransferState}
 */
function createState(sourceFolder, destination, files) { ... }

/**
 * Determine resume plan by comparing current files against saved state.
 * @param {TransferState} state - Previously saved state
 * @param {Array<{wireKey: string, absolutePath: string, size: number, mtime: number}>} currentFiles
 * @returns {{skip: string[], resume: Array<{wireKey: string, offset: number}>, pending: string[]}}
 */
function computeResumePlan(state, currentFiles) { ... }
```

### `server/state.js`

```js
/**
 * Load server-side session tracking.
 * @param {string} outputDir
 * @returns {Object} - { parts: { [partPath]: { sessionId, lastActivity, expectedSize } } }
 */
function loadServerState(outputDir) { ... }

/**
 * Register a .part file with its session.
 * @param {string} outputDir
 * @param {string} partRelativePath - e.g., 'src/large-file.bin.part'
 * @param {string} sessionId
 * @param {number} expectedSize
 */
function registerPart(outputDir, partRelativePath, sessionId, expectedSize) { ... }

/**
 * Remove a .part entry (file completed or deleted).
 * @param {string} outputDir
 * @param {string} partRelativePath
 */
function unregisterPart(outputDir, partRelativePath) { ... }

/**
 * Check if a .part belongs to the given session.
 * @param {string} outputDir
 * @param {string} partRelativePath
 * @param {string} sessionId
 * @returns {{owned: boolean, size: number}} - size is the actual .part file size on disk
 */
function checkPartOwnership(outputDir, partRelativePath, sessionId) { ... }
```

### Modified `file-start` ack (from Phase 4)

Phase 4 always returns `{ ok: true, offset: 0 }`. Phase 5 changes this to:

```js
// server/receiver.js — file-start handler modification
function handleFileStart(socket, payload, ack, outputDir, sessionId) {
  // ... path validation (unchanged from Phase 4) ...

  const partPath = finalPath + '.part';
  let offset = 0;

  if (fs.existsSync(partPath)) {
    const ownership = checkPartOwnership(outputDir, wireKeyPart, sessionId);
    if (ownership.owned) {
      // Same session, can resume
      offset = ownership.size;
    } else {
      // Stale .part from different session — delete
      fs.unlinkSync(partPath);
    }
  }

  // Open file: append if resuming, truncate if fresh
  const fd = fs.openSync(partPath, offset > 0 ? 'a' : 'w');

  // ... register state ...
  ack({ ok: true, offset });
}
```

---

## Acceptance Criteria

1. Kill transfer at 50% of a 100MB file → `state.json` records `bytesSent` → restart → transfer completes from offset, verified by full-file MD5
2. `.remote-sync/state.json` uses atomic write (tmp + rename) — verifiable by checking no partial JSON on disk
3. Modify a completed file (touch to change mtime) → resume correctly re-transfers that file
4. Add new files to folder after partial transfer → resume transfers new files + resumes partial
5. Start fresh transfer to server that has stale `.part` from different session → `.part` deleted, transfer starts from 0
6. `--no-resume` flag still works: skips all state logic, always transfers everything
7. Resume with `--no-checksum` works: uses size+mtime only, no MD5 verification at end
8. State file < 1MB for 50,000 files (each entry ~100 bytes → 5MB... actually use streaming write if needed)
9. 10,000-file resume plan computation (local only, no network) completes in < 1s

---

## Constraints

- **DO NOT** hash the entire file tree upfront for resume decisions — use size+mtime
- **DO NOT** store state on the receiver for sender-side decisions
- **DO NOT** send resume manifests over the wire (as old code did) — the sender makes local decisions, the receiver reports `.part` sizes in `file-start` ack
- **DO NOT** change the `file-chunk` or `file-end` message formats from Phase 4
- **DO NOT** break `--no-resume` behavior (flag means: ignore state, send everything)
- **DO** ensure state is updated after EACH file completes (not just at end of batch)
- **DO** handle state file corruption gracefully (treat as "no state" — fresh transfer)
- **DO** chunk-align resume offsets (round down to nearest CHUNK_SIZE boundary)

---

## Dependencies

- **Phase 4 complete:** The chunked protocol with `file-start` ack returning `offset`, `file-chunk`, and `file-end` must be working.
- The `file-start` ack's `offset` field is the hook for resume. Phase 4 always returns 0; Phase 5 makes it meaningful.
