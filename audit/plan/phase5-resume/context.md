# Phase 5 — Resume Rebuild: Context

## Current Resume Implementation (Being Replaced)

The current resume system is fundamentally broken for cross-machine usage (DEF-008) and imposes catastrophic performance penalties (DEF-009, DEF-010). This section documents what exists and why it fails.

### Current Client-Side Resume (`client/index.js` lines 44-59)

```js
async function queryResume(socket, fileList) {
  console.log('[resume] Computing checksums for resume query...');
  const manifest = [];
  for (const entry of fileList) {
    const checksum = await computeFileChecksum(entry.file);
    manifest.push({ file: entry.file, checksum });
  }

  return new Promise((resolve, reject) => {
    socket.emit('resume-query', manifest);
    socket.once('resume-response', (response) => {
      resolve(response);
    });
    setTimeout(() => reject(new Error('resume-response timeout')), 30000);
  });
}
```

**Problems:**
1. Sends entire manifest as one Socket.IO message → hits `maxHttpBufferSize` limit at ~10K files (DEF-004)
2. Uses absolute paths as keys → never matches on receiver (DEF-008)
3. Computes full MD5 of every file serially before transfer begins (DEF-009, DEF-010)
4. No persistent state — recomputes from scratch every time

### Current Server-Side Resume (`server/index.js` lines 50-74)

```js
socket.on('resume-query', async (manifest, cb) => {
  const skip = [];
  const transfer = [];

  await Promise.all(manifest.map(async (entry) => {
    try {
      await fs.promises.access(entry.file, fs.constants.F_OK);
      const diskChecksum = await computeFileChecksum(entry.file);
      if (diskChecksum === entry.checksum) {
        skip.push(entry.file);
      } else {
        transfer.push(entry.file);
      }
    } catch (err) {
      transfer.push(entry.file);
    }
  }));

  const response = { skip, transfer };
  if (typeof cb === 'function') {
    cb(response);
  } else {
    socket.emit('resume-response', response);
  }
});
```

**Problems:**
1. `Promise.all` over unbounded concurrent hash operations — exhausts file descriptors (DEF-005)
2. Blocks event loop past `pingTimeout` for large directories (DEF-016)
3. Uses absolute sender paths to check receiver filesystem — always fails cross-machine (DEF-008)
4. No persistent state — re-hashes entire tree for every connection

### Current Client-Side Resume Filtering (`client/index.js` lines 212-221)

```js
if (opts.resume && opts.checksum) {
  const resumeResult = await queryResume(socket, fileList);
  const skipSet = new Set(resumeResult.skip || []);
  const transferSet = new Set(resumeResult.transfer || []);

  filesToSend = fileList.filter((entry) => transferSet.has(entry.file));
  console.log(`[resume] Skipping ${skipSet.size} file(s) already on server.`);
  console.log(`[resume] Transferring ${filesToSend.length} file(s).`);
}
```

**Problems:**
1. Resume gated behind BOTH `opts.resume` AND `opts.checksum` (DEF-006, DEF-007)
2. If checksum disabled, resume is silently skipped with no user feedback

---

## New Resume Architecture

### Overview

The new resume system is **sender-driven** and **local-first**:

1. Sender loads `.remote-sync/state.json` from source folder (local file, no network)
2. Sender compares current file list against state using **size+mtime** (cheap, no hashing)
3. Sender categorizes files as: skip, resume, or pending
4. For each file, sender emits `file-start` — receiver reports `.part` size in ack
5. If receiver's `.part` matches sender's expectation → resume from that offset
6. If mismatch → start from 0 (receiver deletes stale `.part`)

**No bulk manifest exchange over the wire.** Each file negotiates its own resume state individually during `file-start`. This eliminates DEF-004 (message size limit) entirely.

### State File Location

```
<sourceFolder>/
├── .remote-sync/
│   └── state.json        ← sender's persistent state
├── src/
│   └── index.js
└── ...
```

On the receiver:
```
<outputDir>/
├── .remote-sync/
│   └── sessions.json     ← tracks which session owns which .part
├── src/
│   ├── index.js          ← completed files
│   └── large-file.bin.part  ← in-progress files
└── ...
```

### Resume Decision Flowchart

```
┌─────────────────────────────────────────────┐
│              File: src/app.js                │
│         Current: size=4096, mtime=T2        │
└─────────────────────────────────────────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │ Is file in state.json? │
         └────────────────────────┘
           │ No                │ Yes
           ▼                   ▼
     ┌──────────┐    ┌─────────────────────┐
     │  PENDING │    │ What is its status?  │
     │ (send    │    └─────────────────────┘
     │  from 0) │      │            │            │
     └──────────┘      ▼            ▼            ▼
                 'completed'   'in-progress'   'pending'
                      │            │              │
                      ▼            ▼              ▼
              ┌────────────┐ ┌────────────┐  ┌──────────┐
              │size+mtime  │ │size+mtime  │  │  PENDING │
              │  match?    │ │  match?    │  │(send     │
              └────────────┘ └────────────┘  │ from 0)  │
               │Yes    │No    │Yes    │No    └──────────┘
               ▼       ▼      ▼       ▼
            ┌──────┐┌──────┐┌──────┐┌──────┐
            │ SKIP ││PEND- ││RESUME││PEND- │
            │      ││ ING  ││from  ││ ING  │
            │      ││      ││offset││      │
            └──────┘└──────┘└──────┘└──────┘
```

### Resume Offset Alignment

Resume offsets are **chunk-aligned** (rounded down to nearest `CHUNK_SIZE` boundary):

```js
const CHUNK_SIZE = 131072; // 128KB

function alignOffset(bytesSent) {
  return Math.floor(bytesSent / CHUNK_SIZE) * CHUNK_SIZE;
}

// Example: bytesSent = 400000 (between chunk 3 and 4)
// alignOffset(400000) = 393216 (3 * 131072)
// Resume from byte 393216, re-send chunk 3 to be safe
```

**Why align?** Because the sender doesn't know if the last chunk was fully written to the `.part` file before the crash. Re-sending one overlapping chunk (at most 128KB) is cheap insurance against partial writes.

### Sender Hash Fast-Forward for Resume

When checksum is enabled and resuming from offset > 0, the sender must include the already-sent bytes in the MD5 computation (because the receiver will verify the FULL file hash at `file-end`):

```js
async function hashFastForward(fd, offset, hash) {
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  let pos = 0;
  while (pos < offset) {
    const toRead = Math.min(CHUNK_SIZE, offset - pos);
    const n = fs.readSync(fd, buffer, 0, toRead, pos);
    hash.update(buffer.subarray(0, n));
    pos += n;
  }
}
```

**Cost:** Local disk read only (no network). For 500MB already sent from a 1GB file:
- SSD: ~0.5s
- HDD: ~5s
- Still much faster than re-transferring 500MB over network

### Receiver `.part` File Handling

The receiver uses `file-start` ack to communicate resume state:

```
Sender sends file-start:
  { fileKey: 'big.bin', size: 1GB, resumeOffset: 500MB, ... }

Receiver checks:
  1. big.bin.part exists? YES (size: 500MB)
  2. Session ID matches? YES
  3. .part size === resumeOffset? YES
  → ack: { ok: true, offset: 500MB }

  OR:
  1. big.bin.part exists? YES (size: 300MB)
  2. Session ID matches? YES
  3. .part size !== resumeOffset (300MB ≠ 500MB)
  → The .part is from this session but shorter than expected
  → ack: { ok: true, offset: 300MB }
  → Sender adjusts its offset to 300MB (re-aligns to chunk boundary)

  OR:
  1. big.bin.part exists? YES
  2. Session ID matches? NO (different session)
  → Delete stale .part
  → ack: { ok: true, offset: 0 }
```

### State Update Frequency

The state is updated:
1. **On file start:** status → 'in-progress', bytesSent → 0
2. **Every N chunks** (default: every 100 chunks = every 12.8MB): bytesSent updated
3. **On file complete:** status → 'completed', md5 stored
4. **On file error:** status → 'failed'
5. **On SIGINT:** current state flushed (Phase 6 handles this)

**Why not every chunk?** Writing state every 128KB (every chunk) would be 8000 writes per 1GB file. At ~1ms per write, that's 8s of pure I/O overhead. Every 100 chunks (12.8MB) means ~80 writes per GB — negligible.

---

## Audit Defects Fixed by This Phase

| Defect | Description | How Fixed |
|--------|-------------|-----------|
| DEF-006 | Resume requires checksum enabled | Resume works with size+mtime alone. Checksum is optional verification at end. |
| DEF-007 | Resume gated behind `opts.checksum` | Resume is independent of checksum flag. |
| DEF-009 | Triple hashing | Already fixed in Phase 4 (single incremental hash). Phase 5 adds hash fast-forward only for resumed portion. |
| DEF-010 | Serial pre-computation | Eliminated. No pre-computation needed. Size+mtime is O(stat) per file. |
| DEF-017 | `--no-resume` semantics | `--no-resume` means: skip state load, skip state save, always send everything. Clear semantics. |

---

## Edge Cases

### File modified during transfer
- Sender detects via `fs.fstatSync(fd)` before closing — if mtime changed during read, mark as failed, don't update state as 'completed'.
- Receiver will have a checksum mismatch (if checksums enabled) → delete `.part`.

### Source folder moved between runs
- State stores `sourceFolder` absolute path. If it doesn't match CWD/`--folder`, state is ignored (treated as fresh transfer).

### Receiver disk full during resume
- `fs.writeSync` throws `ENOSPC` → caught by chunk handler → ack with error → sender marks file failed.

### Multiple senders to same receiver
- Each sender has unique `sessionId`. Server `sessions.json` tracks ownership. No collision.

### `.remote-sync/` directory in transfer list
- `common/files.js` `listFiles()` must EXCLUDE `.remote-sync/` directory from the file list. It's metadata, not user data.
