import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, getDatabase } from '../../src/db/index.js';
import { searchVector, SearchOptions, SearchResult } from '../../src/api/search.js';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), 'test-vector-search.db');

describe('Vector Search', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);
    const db = getDatabase();

    // Create test conversations
    db.prepare(
      "INSERT INTO conversations (id, project, title, file_path, content_hash, source_mtime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('conv1', 'project-a', 'First conversation', '/path/1.jsonl', 'h1', 1000, '2024-01-15');
    db.prepare(
      "INSERT INTO conversations (id, project, title, file_path, content_hash, source_mtime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('conv2', 'project-b', 'Second conversation', '/path/2.jsonl', 'h2', 1001, '2024-02-20');
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  function createEmbedding(seed: number): Buffer {
    const embedding = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      embedding[i] = Math.sin(seed + i * 0.1);
    }
    return Buffer.from(embedding.buffer);
  }

  it('should find similar chunks by vector distance', () => {
    const db = getDatabase();

    // Insert chunks with embeddings
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'first chunk', 1, createEmbedding(1));
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 1, 'assistant', 'second chunk', 1, createEmbedding(100)); // Very different

    // Query with embedding similar to first chunk
    const queryEmbedding = createEmbedding(1.1); // Very close to seed 1
    const results = searchVector(queryEmbedding, {});

    expect(results.length).toBe(2);
    expect(results[0].content).toBe('first chunk'); // Should be closest
  });

  it('should filter by project', () => {
    const db = getDatabase();

    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'project-a chunk', 1, createEmbedding(1));
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv2', 0, 'user', 'project-b chunk', 1, createEmbedding(1));

    const queryEmbedding = createEmbedding(1);
    const results = searchVector(queryEmbedding, { project: 'project-a' });

    expect(results.length).toBe(1);
    expect(results[0].project).toBe('project-a');
  });

  it('should filter by role', () => {
    const db = getDatabase();

    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'user message', 1, createEmbedding(1));
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 1, 'assistant', 'assistant message', 1, createEmbedding(1));

    const queryEmbedding = createEmbedding(1);
    const results = searchVector(queryEmbedding, { role: 'assistant' });

    expect(results.length).toBe(1);
    expect(results[0].role).toBe('assistant');
  });

  it('should filter by date range', () => {
    const db = getDatabase();

    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'january chunk', 1, createEmbedding(1));
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv2', 0, 'user', 'february chunk', 1, createEmbedding(1));

    const queryEmbedding = createEmbedding(1);

    // After January
    const afterResults = searchVector(queryEmbedding, { after: '2024-02-01' });
    expect(afterResults.length).toBe(1);
    expect(afterResults[0].content).toBe('february chunk');

    // Before February
    const beforeResults = searchVector(queryEmbedding, { before: '2024-02-01' });
    expect(beforeResults.length).toBe(1);
    expect(beforeResults[0].content).toBe('january chunk');
  });

  it('should respect limit and offset', () => {
    const db = getDatabase();

    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
      ).run('conv1', i, 'user', `chunk ${i}`, 1, createEmbedding(i));
    }

    const queryEmbedding = createEmbedding(0);
    const results = searchVector(queryEmbedding, { limit: 3, offset: 0 });

    expect(results.length).toBe(3);
  });

  it('should return empty array when no chunks have embeddings', () => {
    const db = getDatabase();

    // Insert chunk without embedding
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number) VALUES (?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'no embedding', 1);

    const queryEmbedding = createEmbedding(1);
    const results = searchVector(queryEmbedding, {});

    expect(results).toEqual([]);
  });

  it('should include conversation metadata in results', () => {
    const db = getDatabase();

    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'test content', 1, createEmbedding(1));

    const queryEmbedding = createEmbedding(1);
    const results = searchVector(queryEmbedding, {});

    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({
      chunk_id: expect.any(Number),
      conversation_id: 'conv1',
      title: 'First conversation',
      project: 'project-a',
      role: 'user',
      content: 'test content',
      page_number: 1,
      score: expect.any(Number),
    });
  });
});
