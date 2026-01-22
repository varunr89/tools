import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, getDatabase } from '../../src/db';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface TableRow { name: string }

const TEST_DB = join(tmpdir(), 'test-schema.db');

describe('Database Schema', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should create all required tables', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: TableRow) => r.name);

    expect(tables).toContain('metadata');
    expect(tables).toContain('conversations');
    expect(tables).toContain('chunks');
  });

  it('should create FTS5 virtual table with trigram tokenizer', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: TableRow) => r.name);
    expect(tables).toContain('chunks_fts');

    db.prepare("INSERT INTO conversations (id, project, file_path, content_hash, source_mtime) VALUES ('c1', 'p', '/f', 'h', 1000)").run();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('c1', 0, 'user', 'authentication')").run();
    const results = db.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'auth'").all();
    expect(results.length).toBeGreaterThan(0);
  });

  it('should enable WAL mode', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    const result = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(result.journal_mode).toBe('wal');
  });

  it('should enable foreign keys', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    const result = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);
  });

  it('should create sync triggers for FTS', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((r: TableRow) => r.name);

    expect(triggers).toContain('chunks_ai');
    expect(triggers).toContain('chunks_ad');
    expect(triggers).toContain('chunks_au');
  });

  it('should sync FTS on chunk insert via trigger', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    db.prepare("INSERT INTO conversations (id, project, file_path, content_hash, source_mtime) VALUES ('c1', 'p', '/f', 'h', 1000)").run();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('c1', 0, 'user', 'searchable content')").run();

    const ftsResults = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'searchable'").all();
    expect(ftsResults.length).toBe(1);
  });

  it('should sync FTS on chunk delete via trigger', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    db.prepare("INSERT INTO conversations (id, project, file_path, content_hash, source_mtime) VALUES ('c1', 'p', '/f', 'h', 1000)").run();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('c1', 0, 'user', 'deleteme')").run();

    expect(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'deleteme'").all().length).toBe(1);

    db.prepare("DELETE FROM chunks WHERE conversation_id = 'c1'").run();

    expect(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'deleteme'").all().length).toBe(0);
  });

  it('should sync FTS on chunk update via trigger', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    db.prepare("INSERT INTO conversations (id, project, file_path, content_hash, source_mtime) VALUES ('c1', 'p', '/f', 'h', 1000)").run();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('c1', 0, 'user', 'oldcontent')").run();

    db.prepare("UPDATE chunks SET content = 'newcontent' WHERE conversation_id = 'c1'").run();

    expect(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'oldcontent'").all().length).toBe(0);
    expect(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'newcontent'").all().length).toBe(1);
  });

  it('should create chunks_vec virtual table for vector search', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: TableRow) => r.name);

    expect(tables).toContain('chunks_vec');
  });

  it('should store and query vectors in chunks_vec', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    // Create a sample embedding (2048 dimensions as specified in design)
    const embedding = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) {
      embedding[i] = Math.random();
    }

    db.prepare("INSERT INTO conversations (id, project, file_path, content_hash, source_mtime) VALUES ('c1', 'p', '/f', 'h', 1000)").run();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content, embedding) VALUES ('c1', 0, 'user', 'test', ?)").run(Buffer.from(embedding.buffer));

    // Query the vector table
    const results = db.prepare("SELECT rowid FROM chunks_vec").all();
    expect(results.length).toBe(1);
  });

  it('should perform cosine similarity search on vectors', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    // Create two embeddings
    const embedding1 = new Float32Array(2048).fill(0.1);
    const embedding2 = new Float32Array(2048).fill(0.9);
    const queryVec = new Float32Array(2048).fill(0.1); // Similar to embedding1

    db.prepare("INSERT INTO conversations (id, project, file_path, content_hash, source_mtime) VALUES ('c1', 'p', '/f', 'h', 1000)").run();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content, embedding) VALUES ('c1', 0, 'user', 'first', ?)").run(Buffer.from(embedding1.buffer));
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content, embedding) VALUES ('c1', 1, 'assistant', 'second', ?)").run(Buffer.from(embedding2.buffer));

    // Search for similar vectors - embedding1 should be closer to queryVec
    const results = db.prepare(`
      SELECT c.id, c.content, vec_distance_cosine(cv.embedding, ?) as distance
      FROM chunks c
      JOIN chunks_vec cv ON cv.rowid = c.id
      ORDER BY distance ASC
      LIMIT 1
    `).all(Buffer.from(queryVec.buffer)) as Array<{id: number, content: string, distance: number}>;

    expect(results.length).toBe(1);
    expect(results[0].content).toBe('first');
  });
});
