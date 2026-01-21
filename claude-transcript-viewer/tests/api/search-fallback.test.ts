import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../../src/db';
import { insertConversation } from '../../src/db/conversations';
import { searchWithFallback } from '../../src/api/search';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), `test-search-fallback-${process.pid}.db`);

describe('Search Fallback', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);

    insertConversation({
      id: 'c1',
      project: 'project-a',
      title: 'Recent',
      created_at: '2025-01-20',
      file_path: '/f1.jsonl',
      content_hash: 'h1',
      source_mtime: 1000,
    });
    insertConversation({
      id: 'c2',
      project: 'project-a',
      title: 'Older',
      created_at: '2025-01-15',
      file_path: '/f2.jsonl',
      content_hash: 'h2',
      source_mtime: 1000,
    });
  });

  afterEach(() => {
    closeDatabase();
    // Clean up database and WAL/SHM files
    for (const suffix of ['', '-wal', '-shm']) {
      const f = TEST_DB + suffix;
      if (existsSync(f)) unlinkSync(f);
    }
  });

  it('should return recent conversations for empty query', () => {
    const results = searchWithFallback('', {});
    expect(results.conversations!.length).toBeGreaterThan(0);
    expect(results.type).toBe('recent');
  });

  it('should return recent conversations for whitespace query', () => {
    const results = searchWithFallback('   ', {});
    expect(results.type).toBe('recent');
  });

  it('should filter recent by project', () => {
    insertConversation({
      id: 'c3',
      project: 'project-b',
      title: 'Other',
      created_at: '2025-01-20',
      file_path: '/f3.jsonl',
      content_hash: 'h3',
      source_mtime: 1000,
    });

    const results = searchWithFallback('', { project: 'project-a' });
    expect(results.conversations!.every((c) => c.project === 'project-a')).toBe(
      true
    );
  });

  it('should order recent by created_at descending', () => {
    const results = searchWithFallback('', {});
    expect(results.conversations![0].title).toBe('Recent');
    expect(results.conversations![1].title).toBe('Older');
  });

  it('should return search results for non-empty query', () => {
    const results = searchWithFallback('nonexistent', {});
    expect(results.type).toBe('search');
  });
});
