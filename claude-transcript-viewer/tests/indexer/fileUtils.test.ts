import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { getFileHash, getFileMtime } from '../../src/indexer/fileUtils';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_FILE = join(tmpdir(), 'test-utils.txt');

describe('File Utilities', () => {
  beforeEach(() => {
    writeFileSync(TEST_FILE, 'test content');
  });

  afterEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  });

  it('should compute SHA256 hash', () => {
    expect(getFileHash(TEST_FILE)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should detect content changes', () => {
    const h1 = getFileHash(TEST_FILE);
    writeFileSync(TEST_FILE, 'different');
    expect(getFileHash(TEST_FILE)).not.toBe(h1);
  });

  it('should return consistent hash for same content', () => {
    const h1 = getFileHash(TEST_FILE);
    const h2 = getFileHash(TEST_FILE);
    expect(h1).toBe(h2);
  });

  it('should get mtime', () => {
    expect(getFileMtime(TEST_FILE)).toBeGreaterThan(0);
  });

  it('should throw for nonexistent file', () => {
    expect(() => getFileHash('/nonexistent/file')).toThrow();
    expect(() => getFileMtime('/nonexistent/file')).toThrow();
  });
});
