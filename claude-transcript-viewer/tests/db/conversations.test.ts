import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, getDatabase } from '../../src/db';
import {
  insertConversation, getConversation, getConversationByPath,
  deleteConversation, listConversations, getRecentConversations, Conversation,
} from '../../src/db/conversations';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), 'test-conversations.db');

describe('Conversation Operations', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  const sample: Conversation = {
    id: 'conv-123',
    project: 'test-project',
    title: 'Test',
    created_at: '2025-01-20T10:00:00Z',
    file_path: '/path/to/file.jsonl',
    content_hash: 'abc123',
    source_mtime: 1705750800,
  };

  it('should insert and retrieve', () => {
    insertConversation(sample);
    const result = getConversation('conv-123');
    expect(result?.id).toBe('conv-123');
    expect(result?.project).toBe('test-project');
    expect(result?.title).toBe('Test');
    expect(result?.file_path).toBe('/path/to/file.jsonl');
  });

  it('should find by path', () => {
    insertConversation(sample);
    expect(getConversationByPath('/path/to/file.jsonl')?.id).toBe('conv-123');
  });

  it('should return null for non-existent conversation', () => {
    expect(getConversation('non-existent')).toBeNull();
  });

  it('should return null for non-existent path', () => {
    expect(getConversationByPath('/non/existent/path')).toBeNull();
  });

  it('should delete', () => {
    insertConversation(sample);
    deleteConversation('conv-123');
    expect(getConversation('conv-123')).toBeNull();
  });

  it('should update on insert with same id (upsert)', () => {
    insertConversation(sample);
    insertConversation({ ...sample, title: 'Updated Title' });
    const result = getConversation('conv-123');
    expect(result?.title).toBe('Updated Title');
  });

  it('should list by project', () => {
    insertConversation(sample);
    insertConversation({ ...sample, id: 'conv-456', project: 'other-project' });
    const results = listConversations('test-project');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('conv-123');
  });

  it('should list all conversations when no project specified', () => {
    insertConversation(sample);
    insertConversation({ ...sample, id: 'conv-456', project: 'other-project' });
    const results = listConversations();
    expect(results).toHaveLength(2);
  });

  it('should get recent conversations with limit', () => {
    insertConversation(sample);
    insertConversation({ ...sample, id: 'conv-456', created_at: '2025-01-19T10:00:00Z' });
    insertConversation({ ...sample, id: 'conv-789', created_at: '2025-01-18T10:00:00Z' });
    const results = getRecentConversations(2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('conv-123'); // Most recent first
  });

  it('should cascade delete chunks when conversation deleted', () => {
    insertConversation(sample);
    const db = getDatabase();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('conv-123', 0, 'user', 'test content')").run();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('conv-123', 1, 'assistant', 'response')").run();

    deleteConversation('conv-123');

    const chunks = db.prepare("SELECT * FROM chunks WHERE conversation_id = 'conv-123'").all();
    expect(chunks).toHaveLength(0);
  });

  it('should cascade delete FTS entries when conversation deleted', () => {
    insertConversation(sample);
    const db = getDatabase();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('conv-123', 0, 'user', 'searchable content here')").run();

    // Verify FTS entry exists
    let ftsResults = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'searchable'").all();
    expect(ftsResults).toHaveLength(1);

    deleteConversation('conv-123');

    // Verify FTS entry is also deleted
    ftsResults = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'searchable'").all();
    expect(ftsResults).toHaveLength(0);
  });

  it('should handle null title', () => {
    const conv: Conversation = { ...sample, title: null };
    insertConversation(conv);
    const result = getConversation('conv-123');
    expect(result?.title).toBeNull();
  });

  it('should handle null created_at', () => {
    const conv: Conversation = { ...sample, created_at: null };
    insertConversation(conv);
    const result = getConversation('conv-123');
    expect(result?.created_at).toBeNull();
  });
});
