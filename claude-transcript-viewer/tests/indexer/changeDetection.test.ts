import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { createDatabase, closeDatabase } from '../../src/db/index.js';
import { insertConversation } from '../../src/db/conversations.js';
import { detectChanges } from '../../src/indexer/changeDetection.js';
import { getFileHash, getFileMtime } from '../../src/indexer/fileUtils.js';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), 'test-changes.db');
const TEST_DIR = join(tmpdir(), 'test-jsonl');

describe('Change Detection', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    createDatabase(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('should detect new files', () => {
    writeFileSync(join(TEST_DIR, 'new.jsonl'), '{}');
    const changes = detectChanges(TEST_DIR);
    expect(changes.added).toHaveLength(1);
    expect(changes.added[0]).toContain('new.jsonl');
  });

  it('should detect modified files via hash change', () => {
    const f = join(TEST_DIR, 'mod.jsonl');
    writeFileSync(f, '{}');
    insertConversation({
      id: 'c1',
      project: 'p',
      title: '',
      created_at: null,
      file_path: f,
      content_hash: 'old-hash-that-does-not-match',
      source_mtime: 0,
    });
    const changes = detectChanges(TEST_DIR);
    expect(changes.modified).toHaveLength(1);
    expect(changes.modified[0]).toContain('mod.jsonl');
  });

  it('should detect deleted files (tombstone)', () => {
    insertConversation({
      id: 'c1',
      project: 'p',
      title: '',
      created_at: null,
      file_path: join(TEST_DIR, 'gone.jsonl'),
      content_hash: 'h',
      source_mtime: 0,
    });
    const changes = detectChanges(TEST_DIR);
    expect(changes.deleted).toContain('c1');
  });

  it('should skip unchanged files (mtime + hash match)', () => {
    const f = join(TEST_DIR, 'same.jsonl');
    writeFileSync(f, '{}');
    insertConversation({
      id: 'c1',
      project: 'p',
      title: '',
      created_at: null,
      file_path: f,
      content_hash: getFileHash(f),
      source_mtime: getFileMtime(f),
    });
    const changes = detectChanges(TEST_DIR);
    expect(changes.added).toHaveLength(0);
    expect(changes.modified).toHaveLength(0);
    expect(changes.deleted).toHaveLength(0);
  });

  it('should use mtime as quick check before hashing', () => {
    const f = join(TEST_DIR, 'quick.jsonl');
    writeFileSync(f, '{}');
    const mtime = getFileMtime(f);
    const hash = getFileHash(f);

    insertConversation({
      id: 'c1',
      project: 'p',
      title: '',
      created_at: null,
      file_path: f,
      content_hash: hash,
      source_mtime: mtime,
    });

    const changes = detectChanges(TEST_DIR);
    expect(changes.modified).toHaveLength(0);
  });

  it('should handle nested directories', () => {
    mkdirSync(join(TEST_DIR, 'sub/nested'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'sub/nested/deep.jsonl'), '{}');
    const changes = detectChanges(TEST_DIR);
    expect(changes.added).toHaveLength(1);
    expect(changes.added[0]).toContain('deep.jsonl');
  });

  it('should only scan .jsonl files', () => {
    writeFileSync(join(TEST_DIR, 'file.txt'), '{}');
    writeFileSync(join(TEST_DIR, 'file.json'), '{}');
    writeFileSync(join(TEST_DIR, 'file.jsonl'), '{}');
    const changes = detectChanges(TEST_DIR);
    expect(changes.added).toHaveLength(1);
    expect(changes.added[0]).toContain('.jsonl');
  });

  it('should handle multiple files in various states', () => {
    // Create new file
    writeFileSync(join(TEST_DIR, 'new.jsonl'), '{}');

    // Create unchanged file
    const unchangedFile = join(TEST_DIR, 'unchanged.jsonl');
    writeFileSync(unchangedFile, '{"unchanged": true}');
    insertConversation({
      id: 'unchanged-id',
      project: 'p',
      title: '',
      created_at: null,
      file_path: unchangedFile,
      content_hash: getFileHash(unchangedFile),
      source_mtime: getFileMtime(unchangedFile),
    });

    // Create modified file
    const modifiedFile = join(TEST_DIR, 'modified.jsonl');
    writeFileSync(modifiedFile, '{"modified": true}');
    insertConversation({
      id: 'modified-id',
      project: 'p',
      title: '',
      created_at: null,
      file_path: modifiedFile,
      content_hash: 'old-hash',
      source_mtime: 0,
    });

    // Reference deleted file
    insertConversation({
      id: 'deleted-id',
      project: 'p',
      title: '',
      created_at: null,
      file_path: join(TEST_DIR, 'deleted.jsonl'),
      content_hash: 'h',
      source_mtime: 0,
    });

    const changes = detectChanges(TEST_DIR);
    expect(changes.added).toHaveLength(1);
    expect(changes.modified).toHaveLength(1);
    expect(changes.deleted).toHaveLength(1);
  });
});
