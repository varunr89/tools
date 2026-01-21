import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, getDatabase } from '../../src/db';
import { insertConversation } from '../../src/db/conversations';
import { insertChunk, getChunksForConversation, searchChunksFTS, Chunk } from '../../src/db/chunks';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), 'test-chunks.db');

describe('Chunk Operations', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);
    insertConversation({
      id: 'conv-123',
      project: 'test',
      title: 'Test',
      created_at: '2025-01-20',
      file_path: '/file.jsonl',
      content_hash: 'h',
      source_mtime: 1000,
    });
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should insert and retrieve', () => {
    insertChunk({
      conversation_id: 'conv-123',
      chunk_index: 0,
      page_number: 1,
      role: 'user',
      content: 'async await question',
      embedding: null,
    });
    expect(getChunksForConversation('conv-123')).toHaveLength(1);
  });

  it('should sync FTS on insert', () => {
    insertChunk({
      conversation_id: 'conv-123',
      chunk_index: 0,
      page_number: 1,
      role: 'assistant',
      content: 'Promise handling',
      embedding: null,
    });
    expect(searchChunksFTS('Promise')).toHaveLength(1);
  });

  it('should support trigram substring search', () => {
    insertChunk({
      conversation_id: 'conv-123',
      chunk_index: 0,
      page_number: 1,
      role: 'user',
      content: 'authentication middleware',
      embedding: null,
    });
    expect(searchChunksFTS('auth')).toHaveLength(1);
    expect(searchChunksFTS('middle')).toHaveLength(1);
  });

  it('should cascade delete', () => {
    insertChunk({
      conversation_id: 'conv-123',
      chunk_index: 0,
      page_number: 1,
      role: 'user',
      content: 'test',
      embedding: null,
    });
    getDatabase().prepare('DELETE FROM conversations WHERE id = ?').run('conv-123');
    expect(getChunksForConversation('conv-123')).toHaveLength(0);
  });

  it('should sanitize FTS special characters', () => {
    insertChunk({
      conversation_id: 'conv-123',
      chunk_index: 0,
      page_number: 1,
      role: 'user',
      content: 'special chars test',
      embedding: null,
    });

    expect(() => searchChunksFTS('test AND')).not.toThrow();
    expect(() => searchChunksFTS('test OR something')).not.toThrow();
    expect(() => searchChunksFTS('test NOT')).not.toThrow();
    expect(() => searchChunksFTS('"quoted"')).not.toThrow();
    expect(() => searchChunksFTS('(parens)')).not.toThrow();
    expect(() => searchChunksFTS('wild*card')).not.toThrow();
  });

  it('should return empty array for empty query', () => {
    expect(searchChunksFTS('')).toHaveLength(0);
    expect(searchChunksFTS('   ')).toHaveLength(0);
  });

  it('should retrieve chunks in order by chunk_index', () => {
    insertChunk({ conversation_id: 'conv-123', chunk_index: 2, page_number: 1, role: 'assistant', content: 'third', embedding: null });
    insertChunk({ conversation_id: 'conv-123', chunk_index: 0, page_number: 1, role: 'user', content: 'first', embedding: null });
    insertChunk({ conversation_id: 'conv-123', chunk_index: 1, page_number: 1, role: 'assistant', content: 'second', embedding: null });

    const chunks = getChunksForConversation('conv-123');
    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('first');
    expect(chunks[1].content).toBe('second');
    expect(chunks[2].content).toBe('third');
  });

  it('should handle null page_number', () => {
    insertChunk({
      conversation_id: 'conv-123',
      chunk_index: 0,
      page_number: null,
      role: 'user',
      content: 'no page number',
      embedding: null,
    });
    const chunks = getChunksForConversation('conv-123');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].page_number).toBeNull();
  });

  it('should return chunk id after insert', () => {
    const id = insertChunk({
      conversation_id: 'conv-123',
      chunk_index: 0,
      page_number: 1,
      role: 'user',
      content: 'test content',
      embedding: null,
    });
    expect(id).toBeGreaterThan(0);
  });
});
