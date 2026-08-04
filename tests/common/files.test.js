'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { listFilesFromFolder } = require('../../common/files');

describe('listFilesFromFolder', () => {
  let tempDir;

  beforeAll(() => {
    // Create a temporary directory structure for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-sync-test-'));

    // Create files
    fs.writeFileSync(path.join(tempDir, 'file1.txt'), 'content1');
    fs.writeFileSync(path.join(tempDir, 'file2.txt'), 'content2');

    // Create subdirectory with files
    const subDir = path.join(tempDir, 'subdir');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'nested.txt'), 'nested content');

    // Create deeper nested structure
    const deepDir = path.join(subDir, 'deep');
    fs.mkdirSync(deepDir);
    fs.writeFileSync(path.join(deepDir, 'deep-file.txt'), 'deep content');
  });

  afterAll(() => {
    // Clean up temp directory recursively
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should list files from a directory', () => {
    const result = listFilesFromFolder(tempDir);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should include type "file" and "folder"', () => {
    const result = listFilesFromFolder(tempDir);
    const types = result.map((entry) => entry.type);
    expect(types).toContain('file');
    expect(types).toContain('folder');
  });

  it('should recurse into subdirectories', () => {
    const result = listFilesFromFolder(tempDir);
    const filePaths = result
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.file);

    // Should find nested.txt inside subdir
    const nestedFile = filePaths.find((f) => f.includes('nested.txt'));
    expect(nestedFile).toBeDefined();
  });

  it('should return empty array for empty directory', () => {
    const emptyDir = path.join(tempDir, 'empty');
    fs.mkdirSync(emptyDir);
    try {
      const result = listFilesFromFolder(emptyDir);
      expect(result).toEqual([]);
    } finally {
      fs.rmdirSync(emptyDir);
    }
  });

  it('should handle nested structures', () => {
    const result = listFilesFromFolder(tempDir);
    const filePaths = result
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.file);

    // Should find the deep-file.txt
    const deepFile = filePaths.find((f) => f.includes('deep-file.txt'));
    expect(deepFile).toBeDefined();

    // Should have exactly 4 files total
    expect(filePaths).toHaveLength(4);
  });

  it('should include folder entries for directories', () => {
    const result = listFilesFromFolder(tempDir);
    const folderEntries = result.filter((entry) => entry.type === 'folder');

    expect(folderEntries.length).toBeGreaterThanOrEqual(2); // subdir and deep
  });

  it('should use the fixture directory correctly', () => {
    const fixturesDir = path.join(__dirname, '../fixtures');
    const result = listFilesFromFolder(fixturesDir);

    const fileNames = result
      .filter((entry) => entry.type === 'file')
      .map((entry) => path.basename(entry.file));

    expect(fileNames).toContain('sample.txt');
    expect(fileNames).toContain('inner.txt');
  });
});
