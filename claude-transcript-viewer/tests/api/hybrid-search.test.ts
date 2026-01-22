import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, closeDatabase, getDatabase } from '../../src/db/index.js';
import {
  searchHybrid,
  HybridSearchResult,
  SearchOptions,
} from '../../src/api/search.js';
import { EmbeddingClient, EmbeddingResponse } from '../../src/embeddings/client.js';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), 'test-hybrid-search.db');

describe('Hybrid Search', () => {
  let mockEmbeddingClient: EmbeddingClient;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);
    const db = getDatabase();

    // Create test conversation
    db.prepare(
      "INSERT INTO conversations (id, project, title, file_path, content_hash, source_mtime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('conv1', 'project-a', 'Test conversation', '/path/1.jsonl', 'h1', 1000, '2024-01-15');

    // Create default mock client
    mockEmbeddingClient = {
      isHealthy: vi.fn().mockResolvedValue(true),
      embed: vi.fn().mockResolvedValue({
        embedding: Array(1024).fill(0.1),
        tokens: 2,
      } as EmbeddingResponse),
      embedBatch: vi.fn().mockResolvedValue([]),
      getModelInfo: vi.fn().mockResolvedValue({ model: 'test', dim: 1024 }),
      close: vi.fn(),
    };
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

  function embeddingToArray(buffer: Buffer): number[] {
    const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    return Array.from(float32);
  }

  it('should perform hybrid search when embeddings available', async () => {
    const db = getDatabase();

    // Insert chunk with embedding (will match vector search)
    const storedEmbedding = createEmbedding(1);
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'hello world test', 1, storedEmbedding);

    // Mock embed to return similar embedding (as number[] which is what the client returns)
    mockEmbeddingClient.embed = vi.fn().mockResolvedValue({
      embedding: embeddingToArray(createEmbedding(1.1)),
      tokens: 2,
    });

    const result = await searchHybrid('hello', {}, mockEmbeddingClient);

    expect(result.type).toBe('hybrid');
    expect(result.results).toBeDefined();
    expect(result.results!.length).toBeGreaterThan(0);
    expect(result.embeddingStatus).toBe('available');
  });

  it('should fallback to FTS when embedding client unavailable', async () => {
    const db = getDatabase();

    // Insert chunk (no embedding needed for FTS)
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number) VALUES (?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'hello world test', 1);

    // Mock embed to return null (unavailable)
    mockEmbeddingClient.embed = vi.fn().mockResolvedValue(null);

    const result = await searchHybrid('hello', {}, mockEmbeddingClient);

    expect(result.type).toBe('fts_only');
    expect(result.results).toBeDefined();
    expect(result.embeddingStatus).toBe('unavailable');
  });

  it('should return recent conversations for empty query', async () => {
    const result = await searchHybrid('', {}, mockEmbeddingClient);

    expect(result.type).toBe('recent');
    expect(result.conversations).toBeDefined();
  });

  it('should apply filters in hybrid search', async () => {
    const db = getDatabase();

    db.prepare(
      "INSERT INTO conversations (id, project, title, file_path, content_hash, source_mtime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('conv2', 'project-b', 'Other conversation', '/path/2.jsonl', 'h2', 1001, '2024-02-20');

    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'hello world', 1, createEmbedding(1));
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv2', 0, 'user', 'hello world', 1, createEmbedding(1));

    mockEmbeddingClient.embed = vi.fn().mockResolvedValue({
      embedding: embeddingToArray(createEmbedding(1)),
      tokens: 2,
    });

    const result = await searchHybrid(
      'hello',
      { project: 'project-a' },
      mockEmbeddingClient
    );

    expect(result.results).toBeDefined();
    expect(result.results!.every((r) => r.project === 'project-a')).toBe(true);
  });

  it('should boost results appearing in both vector and FTS', async () => {
    const db = getDatabase();

    // Insert chunks - one that matches both vector and FTS well
    const matchingEmbedding = createEmbedding(1);
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'unique keyword searchterm', 1, matchingEmbedding);
    // Another that only matches vector
    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('conv1', 1, 'user', 'different content here', 1, matchingEmbedding);

    mockEmbeddingClient.embed = vi.fn().mockResolvedValue({
      embedding: embeddingToArray(matchingEmbedding),
      tokens: 2,
    });

    const result = await searchHybrid('searchterm', {}, mockEmbeddingClient);

    expect(result.type).toBe('hybrid');
    expect(result.results).toBeDefined();
    // First result should be the one matching both (has "searchterm" in content)
    expect(result.results![0].content).toContain('searchterm');
  });

  it('should handle no results gracefully', async () => {
    // Empty database (no chunks)
    mockEmbeddingClient.embed = vi.fn().mockResolvedValue({
      embedding: Array.from(createEmbedding(1)),
      tokens: 2,
    });

    const result = await searchHybrid('nonexistent', {}, mockEmbeddingClient);

    expect(result.results).toEqual([]);
  });

  it('should work without embedding client (FTS only mode)', async () => {
    const db = getDatabase();

    db.prepare(
      "INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number) VALUES (?, ?, ?, ?, ?)"
    ).run('conv1', 0, 'user', 'hello world', 1);

    // Pass null/undefined client
    const result = await searchHybrid('hello', {});

    expect(result.type).toBe('fts_only');
    expect(result.results).toBeDefined();
    expect(result.embeddingStatus).toBe('unavailable');
  });
});
