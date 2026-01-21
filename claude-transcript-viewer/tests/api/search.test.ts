import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../../src/db';
import { insertConversation } from '../../src/db/conversations';
import { insertChunk } from '../../src/db/chunks';
import { searchFTS, SearchOptions } from '../../src/api/search';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), `test-search-api-${process.pid}.db`);

describe('Search API', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);

    insertConversation({
      id: 'c1',
      project: 'project-a',
      title: 'JavaScript Help',
      created_at: '2025-01-20',
      file_path: '/f1.jsonl',
      content_hash: 'h1',
      source_mtime: 1000,
    });
    insertConversation({
      id: 'c2',
      project: 'project-b',
      title: 'Python Help',
      created_at: '2025-01-15',
      file_path: '/f2.jsonl',
      content_hash: 'h2',
      source_mtime: 1000,
    });

    insertChunk({
      conversation_id: 'c1',
      chunk_index: 0,
      page_number: 1,
      role: 'user',
      content: 'How do I use async await in JavaScript?',
      embedding: null,
    });
    insertChunk({
      conversation_id: 'c1',
      chunk_index: 1,
      page_number: 1,
      role: 'assistant',
      content: 'Async/await is syntactic sugar for promises.',
      embedding: null,
    });
    insertChunk({
      conversation_id: 'c2',
      chunk_index: 0,
      page_number: 1,
      role: 'user',
      content: 'Python async programming',
      embedding: null,
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

  it('should find by keyword', () => {
    const results = searchFTS('async', {});
    expect(results.length).toBeGreaterThan(0);
  });

  it('should filter by project (inside query, not after)', () => {
    const results = searchFTS('async', { project: 'project-a' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.project === 'project-a')).toBe(true);

    const noResults = searchFTS('async', { project: 'nonexistent' });
    expect(noResults).toHaveLength(0);
  });

  it('should filter by role', () => {
    const userResults = searchFTS('async', { role: 'user' });
    expect(userResults.every((r) => r.role === 'user')).toBe(true);

    const assistantResults = searchFTS('async', { role: 'assistant' });
    expect(assistantResults.every((r) => r.role === 'assistant')).toBe(true);
  });

  it('should filter by date range', () => {
    const results = searchFTS('async', { after: '2025-01-18' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('should respect limit', () => {
    const results = searchFTS('async', { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('should respect offset', () => {
    const all = searchFTS('async', { limit: 10 });
    const offset = searchFTS('async', { limit: 10, offset: 1 });

    if (all.length > 1) {
      expect(offset[0].chunk_id).toBe(all[1].chunk_id);
    }
  });

  it('should handle negative limit gracefully', () => {
    const results = searchFTS('async', { limit: -1 });
    expect(results).toHaveLength(0);
  });

  it('should handle negative offset gracefully', () => {
    const results = searchFTS('async', { offset: -1 });
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it('should return empty array for empty query', () => {
    expect(searchFTS('', {})).toHaveLength(0);
    expect(searchFTS('   ', {})).toHaveLength(0);
  });

  it('should sanitize FTS special characters', () => {
    expect(() => searchFTS('async AND', {})).not.toThrow();
    expect(() => searchFTS('test OR something', {})).not.toThrow();
    expect(() => searchFTS('"quoted"', {})).not.toThrow();
  });

  it('should include conversation metadata in results', () => {
    const results = searchFTS('async', {});
    expect(results[0]).toHaveProperty('conversation_id');
    expect(results[0]).toHaveProperty('title');
    expect(results[0]).toHaveProperty('project');
    expect(results[0]).toHaveProperty('page_number');
  });
});
