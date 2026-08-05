'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadManifest,
  saveManifest,
  updateFileEntry,
  markComplete,
  registerPartial,
  determineOffset,
  reconcile,
  removeEntry,
  getManifestDir,
  getManifestPath
} = require('../../server/manifest');
const { fromWireKey } = require('../../common/files');

describe('server/manifest', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-sync-manifest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadManifest', () => {
    it('should return empty manifest when no file exists', () => {
      const manifest = loadManifest(tmpDir);
      expect(manifest).toEqual({ files: {} });
    });

    it('should load a valid manifest from disk', () => {
      const manifestDir = path.join(tmpDir, '.remote-sync');
      fs.mkdirSync(manifestDir, { recursive: true });
      const data = { files: { 'test.txt': { expectedSize: 100, bytesWritten: 100, status: 'complete', lastModified: '2024-01-01T00:00:00Z' } } };
      fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(data));

      const manifest = loadManifest(tmpDir);
      expect(manifest.files['test.txt'].expectedSize).toBe(100);
      expect(manifest.files['test.txt'].status).toBe('complete');
    });

    it('should handle corrupt JSON gracefully (return empty)', () => {
      const manifestDir = path.join(tmpDir, '.remote-sync');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(path.join(manifestDir, 'manifest.json'), '{invalid json!!!');

      const manifest = loadManifest(tmpDir);
      expect(manifest).toEqual({ files: {} });
    });

    it('should discard stale .tmp file when manifest is missing', () => {
      const manifestDir = path.join(tmpDir, '.remote-sync');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(path.join(manifestDir, '.manifest.json.tmp'), '{"files":{}}');

      const manifest = loadManifest(tmpDir);
      expect(manifest).toEqual({ files: {} });
      expect(fs.existsSync(path.join(manifestDir, '.manifest.json.tmp'))).toBe(false);
    });
  });

  describe('saveManifest', () => {
    it('should create .remote-sync directory and write manifest atomically', () => {
      const data = { files: { 'src/app.js': { expectedSize: 500, bytesWritten: 500, status: 'complete', lastModified: '2024-01-01T00:00:00Z' } } };
      saveManifest(tmpDir, data);

      const manifestPath = getManifestPath(tmpDir);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(loaded.files['src/app.js'].expectedSize).toBe(500);
    });

    it('should not leave .tmp file after successful write', () => {
      saveManifest(tmpDir, { files: {} });
      const tmpPath = path.join(tmpDir, '.remote-sync', '.manifest.json.tmp');
      expect(fs.existsSync(tmpPath)).toBe(false);
    });
  });

  describe('updateFileEntry', () => {
    it('should create entry if not exists', () => {
      updateFileEntry(tmpDir, 'new-file.txt', { expectedSize: 200, bytesWritten: 50, status: 'partial' });

      const manifest = loadManifest(tmpDir);
      expect(manifest.files['new-file.txt'].expectedSize).toBe(200);
      expect(manifest.files['new-file.txt'].bytesWritten).toBe(50);
      expect(manifest.files['new-file.txt'].status).toBe('partial');
      expect(manifest.files['new-file.txt'].lastModified).toBeDefined();
    });

    it('should merge with existing entry', () => {
      updateFileEntry(tmpDir, 'file.txt', { expectedSize: 1000, bytesWritten: 0, status: 'partial' });
      updateFileEntry(tmpDir, 'file.txt', { bytesWritten: 500 });

      const manifest = loadManifest(tmpDir);
      expect(manifest.files['file.txt'].expectedSize).toBe(1000);
      expect(manifest.files['file.txt'].bytesWritten).toBe(500);
    });
  });

  describe('markComplete', () => {
    it('should mark file as complete with checksum', () => {
      markComplete(tmpDir, 'data.bin', 4096, 'abc123def456');

      const manifest = loadManifest(tmpDir);
      expect(manifest.files['data.bin'].status).toBe('complete');
      expect(manifest.files['data.bin'].expectedSize).toBe(4096);
      expect(manifest.files['data.bin'].bytesWritten).toBe(4096);
      expect(manifest.files['data.bin'].expectedChecksum).toBe('abc123def456');
    });

    it('should mark file as complete without checksum', () => {
      markComplete(tmpDir, 'data.bin', 4096, null);

      const manifest = loadManifest(tmpDir);
      expect(manifest.files['data.bin'].status).toBe('complete');
      expect(manifest.files['data.bin'].expectedChecksum).toBeUndefined();
    });
  });

  describe('registerPartial', () => {
    it('should register a partial file entry', () => {
      registerPartial(tmpDir, 'big-file.zip', 10000, 'checksum123', 5000);

      const manifest = loadManifest(tmpDir);
      expect(manifest.files['big-file.zip'].status).toBe('partial');
      expect(manifest.files['big-file.zip'].expectedSize).toBe(10000);
      expect(manifest.files['big-file.zip'].bytesWritten).toBe(5000);
      expect(manifest.files['big-file.zip'].expectedChecksum).toBe('checksum123');
    });
  });

  describe('determineOffset', () => {
    it('should return 0 when resume is disabled', () => {
      markComplete(tmpDir, 'test.txt', 100, null);
      // Create the actual file
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), Buffer.alloc(100));

      const offset = determineOffset(tmpDir, 'test.txt', 100, null, false);
      expect(offset).toBe(0);
    });

    it('should return size (skip) for complete file with matching size', () => {
      markComplete(tmpDir, 'test.txt', 100, null);
      // Create the actual file with matching size
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), Buffer.alloc(100));

      const offset = determineOffset(tmpDir, 'test.txt', 100, null, true);
      expect(offset).toBe(100);
    });

    it('should return size (skip) for complete file with matching checksum', () => {
      markComplete(tmpDir, 'test.txt', 100, 'abc123');
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), Buffer.alloc(100));

      const offset = determineOffset(tmpDir, 'test.txt', 100, 'abc123', true);
      expect(offset).toBe(100);
    });

    it('should return 0 for complete file with checksum mismatch', () => {
      markComplete(tmpDir, 'test.txt', 100, 'abc123');
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), Buffer.alloc(100));

      const offset = determineOffset(tmpDir, 'test.txt', 100, 'different', true);
      expect(offset).toBe(0);
    });

    it('should return 0 for complete file with size mismatch', () => {
      markComplete(tmpDir, 'test.txt', 100, null);
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), Buffer.alloc(100));

      // Sender says size is 200, manifest says 100 → mismatch
      const offset = determineOffset(tmpDir, 'test.txt', 200, null, true);
      expect(offset).toBe(0);
    });

    it('should return .part file size for partial transfer', () => {
      // Use sizes larger than CHUNK_SIZE (131072) so chunk-alignment returns a non-zero offset
      const CHUNK_SIZE = 131072;
      const partSize = CHUNK_SIZE * 3 + 500; // 3 full chunks + partial
      const totalSize = CHUNK_SIZE * 10;
      registerPartial(tmpDir, 'big.bin', totalSize, null, partSize);
      // Create the .part file with partSize bytes
      fs.writeFileSync(path.join(tmpDir, 'big.bin.part'), Buffer.alloc(partSize));

      const offset = determineOffset(tmpDir, 'big.bin', totalSize, null, true);
      // Chunk-aligned: floor(partSize / CHUNK_SIZE) * CHUNK_SIZE = 3 * CHUNK_SIZE
      expect(offset).toBe(CHUNK_SIZE * 3);
    });

    it('should return actual .part file size even if manifest differs', () => {
      // Use sizes larger than CHUNK_SIZE so chunk-alignment returns a non-zero offset
      const CHUNK_SIZE = 131072;
      const manifestBytes = CHUNK_SIZE * 5;
      const actualPartSize = CHUNK_SIZE * 2 + 100; // crash during 3rd chunk
      const totalSize = CHUNK_SIZE * 10;
      registerPartial(tmpDir, 'big.bin', totalSize, null, manifestBytes);
      // .part file has fewer bytes than manifest claims (crash during write)
      fs.writeFileSync(path.join(tmpDir, 'big.bin.part'), Buffer.alloc(actualPartSize));

      const offset = determineOffset(tmpDir, 'big.bin', totalSize, null, true);
      // Chunk-aligned: floor(actualPartSize / CHUNK_SIZE) * CHUNK_SIZE = 2 * CHUNK_SIZE
      expect(offset).toBe(CHUNK_SIZE * 2);
    });

    it('should return 0 when .part file does not exist for partial entry', () => {
      registerPartial(tmpDir, 'big.bin', 10000, null, 5000);
      // No .part file on disk

      const offset = determineOffset(tmpDir, 'big.bin', 10000, null, true);
      expect(offset).toBe(0);
    });

    it('should return 0 for empty file (size 0)', () => {
      const offset = determineOffset(tmpDir, 'empty.txt', 0, null, true);
      expect(offset).toBe(0);
    });

    it('should return 0 for unknown file', () => {
      const offset = determineOffset(tmpDir, 'unknown.txt', 500, null, true);
      expect(offset).toBe(0);
    });

    it('should return 0 when complete file is missing from disk', () => {
      markComplete(tmpDir, 'gone.txt', 100, null);
      // Don't create the file on disk

      const offset = determineOffset(tmpDir, 'gone.txt', 100, null, true);
      expect(offset).toBe(0);
    });
  });

  describe('reconcile', () => {
    it('should delete .part files without manifest entries', () => {
      const partFile = path.join(tmpDir, 'stale.txt.part');
      fs.writeFileSync(partFile, Buffer.alloc(100));

      reconcile(tmpDir);

      expect(fs.existsSync(partFile)).toBe(false);
    });

    it('should keep .part files that have manifest entries', () => {
      registerPartial(tmpDir, 'active.txt', 1000, null, 500);
      const partFile = path.join(tmpDir, 'active.txt.part');
      fs.writeFileSync(partFile, Buffer.alloc(500));

      reconcile(tmpDir);

      expect(fs.existsSync(partFile)).toBe(true);
    });

    it('should handle nested .part files', () => {
      // Create nested stale .part
      const nestedDir = path.join(tmpDir, 'sub', 'dir');
      fs.mkdirSync(nestedDir, { recursive: true });
      const partFile = path.join(nestedDir, 'file.bin.part');
      fs.writeFileSync(partFile, Buffer.alloc(200));

      reconcile(tmpDir);

      expect(fs.existsSync(partFile)).toBe(false);
    });

    it('should not crash on empty directory', () => {
      expect(() => reconcile(tmpDir)).not.toThrow();
    });
  });

  describe('removeEntry', () => {
    it('should remove a file entry from manifest', () => {
      markComplete(tmpDir, 'delete-me.txt', 100, null);
      removeEntry(tmpDir, 'delete-me.txt');

      const manifest = loadManifest(tmpDir);
      expect(manifest.files['delete-me.txt']).toBeUndefined();
    });
  });
});
