import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, getDatabase } from '../../src/db';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
      .map((r: any) => r.name);

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
      .map((r: any) => r.name);
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
      .map((r: any) => r.name);

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
});
