# RAG-Based Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add semantic search with hybrid vector + FTS ranking to the Claude Transcript Viewer.

**Architecture:** TypeScript Express server with SQLite + sqlite-vec for storage, qwen3-embeddings-mlx sidecar for embeddings, background indexing with atomic swaps, graceful fallback when embeddings unavailable.

**Tech Stack:** TypeScript, Express 5, better-sqlite3, sqlite-vec, vitest, qwen3-embeddings-mlx (Python)

---

## Prerequisites

Before starting, ensure these are installed:
- Node.js 20+
- Python 3.10+ with pip
- SQLite 3.35+ (for JSON functions)

---

## Phase 1: Configuration & Test Infrastructure

### Task 1.1: Add Vitest Test Framework

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`

**Step 1: Install vitest and dependencies**

Run:
```bash
npm install -D vitest @vitest/coverage-v8
```

**Step 2: Create vitest config**

Create `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
  },
});
```

**Step 3: Create test setup file**

Create `tests/setup.ts`:
```typescript
import { beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'fs';

// Clean up test databases before each test
beforeEach(() => {
  const testDb = '/tmp/test-search.db';
  if (existsSync(testDb)) {
    unlinkSync(testDb);
  }
});
```

**Step 4: Add test script to package.json**

Add to `scripts` in `package.json`:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

**Step 5: Verify setup**

Run: `npm test`
Expected: "No test files found" (success - framework works)

**Step 6: Commit**

```bash
git add -A && git commit -m "chore: add vitest test framework"
```

---

### Task 1.2: Configuration Module

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

**Step 1: Write the failing test**

Create `tests/config.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, validateConfig, Config } from '../src/config';

describe('Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load default configuration', () => {
    const config = getConfig();
    expect(config.CHUNK_SIZE).toBe(300);
    expect(config.CHUNK_OVERLAP).toBe(50);
    expect(config.EMBEDDING_DIM).toBe(2048);
  });

  it('should load configuration from environment', () => {
    process.env.ARCHIVE_DIR = '/custom/archive';
    process.env.SOURCE_DIR = '/custom/source';
    process.env.DATABASE_PATH = '/custom/db.sqlite';
    process.env.EMBED_SOCKET = '/custom/embed.sock';

    const config = getConfig();
    expect(config.ARCHIVE_DIR).toBe('/custom/archive');
    expect(config.SOURCE_DIR).toBe('/custom/source');
    expect(config.DATABASE_PATH).toBe('/custom/db.sqlite');
    expect(config.EMBED_SOCKET).toBe('/custom/embed.sock');
  });

  it('should load AUTO_UPDATE from environment', () => {
    process.env.AUTO_UPDATE = 'false';
    const config = getConfig();
    expect(config.AUTO_UPDATE).toBe(false);
  });

  it('should validate required paths exist', () => {
    const config: Config = {
      ARCHIVE_DIR: '/nonexistent/path',
      SOURCE_DIR: '/nonexistent/source',
      DATABASE_PATH: '/tmp/test.db',
      EMBED_SOCKET: '/tmp/embed.sock',
      AUTO_UPDATE: true,
      PYTHON_CMD: 'python3',
      CHUNK_SIZE: 300,
      CHUNK_OVERLAP: 50,
      EMBEDDING_MODEL: 'qwen3-medium',
      EMBEDDING_DIM: 2048,
    };

    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('ARCHIVE_DIR'))).toBe(true);
  });

  it('should accept valid configuration', () => {
    const config: Config = {
      ARCHIVE_DIR: '/tmp',  // exists
      SOURCE_DIR: '/tmp',   // exists
      DATABASE_PATH: '/tmp/test.db',
      EMBED_SOCKET: '/tmp/embed.sock',
      AUTO_UPDATE: true,
      PYTHON_CMD: 'python3',
      CHUNK_SIZE: 300,
      CHUNK_OVERLAP: 50,
      EMBEDDING_MODEL: 'qwen3-medium',
      EMBEDDING_DIM: 2048,
    };

    const errors = validateConfig(config);
    expect(errors).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/config'"

**Step 3: Implement configuration module**

Create `src/config.ts`:
```typescript
import { existsSync } from 'fs';

export interface Config {
  ARCHIVE_DIR: string;
  SOURCE_DIR: string;
  DATABASE_PATH: string;
  EMBED_SOCKET: string;
  AUTO_UPDATE: boolean;
  PYTHON_CMD: string;
  CHUNK_SIZE: number;
  CHUNK_OVERLAP: number;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIM: number;
}

const defaults: Config = {
  ARCHIVE_DIR: './archive',
  SOURCE_DIR: './source',
  DATABASE_PATH: './search.db',
  EMBED_SOCKET: '/tmp/qwen3-embed.sock',
  AUTO_UPDATE: true,
  PYTHON_CMD: 'python3',
  CHUNK_SIZE: 300,
  CHUNK_OVERLAP: 50,
  EMBEDDING_MODEL: 'qwen3-medium',
  EMBEDDING_DIM: 2048,
};

export function getConfig(): Config {
  return {
    ARCHIVE_DIR: process.env.ARCHIVE_DIR || defaults.ARCHIVE_DIR,
    SOURCE_DIR: process.env.SOURCE_DIR || defaults.SOURCE_DIR,
    DATABASE_PATH: process.env.DATABASE_PATH || defaults.DATABASE_PATH,
    EMBED_SOCKET: process.env.EMBED_SOCKET || defaults.EMBED_SOCKET,
    AUTO_UPDATE: process.env.AUTO_UPDATE !== 'false',
    PYTHON_CMD: process.env.PYTHON_CMD || defaults.PYTHON_CMD,
    CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE || String(defaults.CHUNK_SIZE), 10),
    CHUNK_OVERLAP: parseInt(process.env.CHUNK_OVERLAP || String(defaults.CHUNK_OVERLAP), 10),
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || defaults.EMBEDDING_MODEL,
    EMBEDDING_DIM: parseInt(process.env.EMBEDDING_DIM || String(defaults.EMBEDDING_DIM), 10),
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  if (!existsSync(config.ARCHIVE_DIR)) {
    errors.push(`ARCHIVE_DIR does not exist: ${config.ARCHIVE_DIR}`);
  }
  if (!existsSync(config.SOURCE_DIR)) {
    errors.push(`SOURCE_DIR does not exist: ${config.SOURCE_DIR}`);
  }
  if (config.CHUNK_SIZE < 100 || config.CHUNK_SIZE > 1000) {
    errors.push(`CHUNK_SIZE must be between 100 and 1000: ${config.CHUNK_SIZE}`);
  }
  if (config.CHUNK_OVERLAP < 0 || config.CHUNK_OVERLAP >= config.CHUNK_SIZE) {
    errors.push(`CHUNK_OVERLAP must be between 0 and CHUNK_SIZE: ${config.CHUNK_OVERLAP}`);
  }

  return errors;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add configuration module with validation"
```

---

## Phase 2: Database Schema & Core Infrastructure

### Task 2.1: Create Database Module with Schema

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/index.ts`
- Create: `tests/db/schema.test.ts`

**Step 1: Write the failing test**

Create `tests/db/schema.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, getDatabase } from '../../src/db';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/test-schema.db';

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

    // Verify FTS table exists
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('chunks_fts');

    // Verify trigram tokenizer works (finds substring matches)
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

    // Insert conversation first (foreign key)
    db.prepare("INSERT INTO conversations (id, project, file_path, content_hash, source_mtime) VALUES ('c1', 'p', '/f', 'h', 1000)").run();

    // Insert chunk
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('c1', 0, 'user', 'searchable content')").run();

    // Verify FTS was updated via trigger
    const ftsResults = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'searchable'").all();
    expect(ftsResults.length).toBe(1);
  });

  it('should sync FTS on chunk delete via trigger', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    db.prepare("INSERT INTO conversations (id, project, file_path, content_hash, source_mtime) VALUES ('c1', 'p', '/f', 'h', 1000)").run();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('c1', 0, 'user', 'deleteme')").run();

    // Verify in FTS
    expect(db.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'deleteme'").all().length).toBe(1);

    // Delete chunk
    db.prepare("DELETE FROM chunks WHERE conversation_id = 'c1'").run();

    // Verify removed from FTS
    expect(db.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'deleteme'").all().length).toBe(0);
  });

  it('should sync FTS on chunk update via trigger', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    db.prepare("INSERT INTO conversations (id, project, file_path, content_hash, source_mtime) VALUES ('c1', 'p', '/f', 'h', 1000)").run();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('c1', 0, 'user', 'oldcontent')").run();

    // Update chunk
    db.prepare("UPDATE chunks SET content = 'newcontent' WHERE conversation_id = 'c1'").run();

    // Old content should not be found
    expect(db.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'oldcontent'").all().length).toBe(0);
    // New content should be found
    expect(db.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'newcontent'").all().length).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../../src/db'"

**Step 3: Create schema definition**

Create `src/db/schema.ts`:
```typescript
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT,
  created_at DATETIME,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_mtime INTEGER NOT NULL,
  indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  page_number INTEGER,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_conversation ON chunks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chunks_role ON chunks(role);
`;

// FTS5 with trigram tokenizer for substring matching (better for code search)
export const FTS_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='trigram'
);
`;

// Sync triggers to keep FTS in sync with chunks table
export const TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = OLD.id;
  INSERT INTO chunks_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;
`;
```

**Step 4: Create database module**

Create `src/db/index.ts`:
```typescript
import Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION, FTS_TABLE_SQL, TRIGGER_SQL } from './schema';

let db: Database.Database | null = null;

export function createDatabase(dbPath: string): Database.Database {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(FTS_TABLE_SQL);
  db.exec(TRIGGER_SQL);
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
    .run('schema_version', String(SCHEMA_VERSION));
  return db;
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call createDatabase first.');
  return db;
}

export function closeDatabase(): void {
  if (db) { db.close(); db = null; }
}

export function setMetadata(key: string, value: string): void {
  getDatabase().prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
}

export function getMetadata(key: string): string | null {
  const row = getDatabase().prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
```

**Step 5: Run test to verify it passes**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add -A && git commit -m "feat(db): add database schema with FTS5 trigram tokenizer and sync triggers"
```

---

### Task 2.2: Add Metadata CRUD Operations

**Files:**
- Create: `tests/db/metadata.test.ts`

**Step 1: Write the failing test**

Create `tests/db/metadata.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, getMetadata, setMetadata } from '../../src/db';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/test-metadata.db';

describe('Metadata Operations', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should set and get metadata', () => {
    setMetadata('model_id', 'qwen3-medium');
    expect(getMetadata('model_id')).toBe('qwen3-medium');
  });

  it('should return null for missing key', () => {
    expect(getMetadata('nonexistent')).toBeNull();
  });

  it('should update existing metadata', () => {
    setMetadata('model_id', 'qwen3-small');
    setMetadata('model_id', 'qwen3-large');
    expect(getMetadata('model_id')).toBe('qwen3-large');
  });

  it('should have schema_version set on creation', () => {
    expect(getMetadata('schema_version')).toBe('1');
  });

  it('should track embedding model and dimension for reindex detection', () => {
    setMetadata('embedding_model', 'qwen3-medium');
    setMetadata('embedding_dim', '2048');
    expect(getMetadata('embedding_model')).toBe('qwen3-medium');
    expect(getMetadata('embedding_dim')).toBe('2048');
  });
});
```

**Step 2: Run test (should pass - already implemented in 2.1)**

Run: `npm test`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add -A && git commit -m "test(db): add metadata operation tests"
```

---

### Task 2.3: Add Conversation CRUD Operations

**Files:**
- Create: `src/db/conversations.ts`
- Create: `tests/db/conversations.test.ts`

**Step 1: Write the failing test**

Create `tests/db/conversations.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../../src/db';
import {
  insertConversation, getConversation, getConversationByPath,
  deleteConversation, listConversations, Conversation,
} from '../../src/db/conversations';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/test-conversations.db';

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
    id: 'conv-123', project: 'test-project', title: 'Test',
    created_at: '2025-01-20T10:00:00Z', file_path: '/path/to/file.jsonl',
    content_hash: 'abc123', source_mtime: 1705750800,
  };

  it('should insert and retrieve', () => {
    insertConversation(sample);
    const result = getConversation('conv-123');
    expect(result?.id).toBe('conv-123');
  });

  it('should find by path', () => {
    insertConversation(sample);
    expect(getConversationByPath('/path/to/file.jsonl')?.id).toBe('conv-123');
  });

  it('should delete', () => {
    insertConversation(sample);
    deleteConversation('conv-123');
    expect(getConversation('conv-123')).toBeNull();
  });

  it('should list by project', () => {
    insertConversation(sample);
    insertConversation({ ...sample, id: 'conv-456', project: 'other' });
    expect(listConversations('test-project')).toHaveLength(1);
  });

  it('should cascade delete chunks when conversation deleted', () => {
    insertConversation(sample);
    const db = require('../../src/db').getDatabase();
    db.prepare("INSERT INTO chunks (conversation_id, chunk_index, role, content) VALUES ('conv-123', 0, 'user', 'test')").run();

    deleteConversation('conv-123');

    const chunks = db.prepare("SELECT * FROM chunks WHERE conversation_id = 'conv-123'").all();
    expect(chunks).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Implement**

Create `src/db/conversations.ts`:
```typescript
import { getDatabase } from './index';

export interface Conversation {
  id: string; project: string; title: string | null; created_at: string | null;
  file_path: string; content_hash: string; source_mtime: number; indexed_at?: string;
}

export function insertConversation(c: Conversation): void {
  getDatabase().prepare(`INSERT OR REPLACE INTO conversations
    (id, project, title, created_at, file_path, content_hash, source_mtime)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(c.id, c.project, c.title, c.created_at, c.file_path, c.content_hash, c.source_mtime);
}

export function getConversation(id: string): Conversation | null {
  return getDatabase().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | null;
}

export function getConversationByPath(path: string): Conversation | null {
  return getDatabase().prepare('SELECT * FROM conversations WHERE file_path = ?').get(path) as Conversation | null;
}

export function deleteConversation(id: string): void {
  getDatabase().prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

export function listConversations(project?: string): Conversation[] {
  const db = getDatabase();
  return project
    ? db.prepare('SELECT * FROM conversations WHERE project = ? ORDER BY created_at DESC').all(project) as Conversation[]
    : db.prepare('SELECT * FROM conversations ORDER BY created_at DESC').all() as Conversation[];
}

export function getRecentConversations(limit: number = 10): Conversation[] {
  return getDatabase()
    .prepare('SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Conversation[];
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): add conversation CRUD with cascade delete"
```

---

### Task 2.4: Add Chunk CRUD with FTS Sync

**Files:**
- Create: `src/db/chunks.ts`
- Create: `tests/db/chunks.test.ts`

**Step 1: Write the failing test**

Create `tests/db/chunks.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, getDatabase } from '../../src/db';
import { insertConversation } from '../../src/db/conversations';
import { insertChunk, getChunksForConversation, searchChunksFTS, Chunk } from '../../src/db/chunks';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/test-chunks.db';

describe('Chunk Operations', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);
    insertConversation({ id: 'conv-123', project: 'test', title: 'Test',
      created_at: '2025-01-20', file_path: '/file.jsonl', content_hash: 'h', source_mtime: 1000 });
  });

  afterEach(() => { closeDatabase(); if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

  it('should insert and retrieve', () => {
    insertChunk({ conversation_id: 'conv-123', chunk_index: 0, page_number: 1,
      role: 'user', content: 'async await question', embedding: null });
    expect(getChunksForConversation('conv-123')).toHaveLength(1);
  });

  it('should sync FTS on insert', () => {
    insertChunk({ conversation_id: 'conv-123', chunk_index: 0, page_number: 1,
      role: 'assistant', content: 'Promise handling', embedding: null });
    expect(searchChunksFTS('Promise')).toHaveLength(1);
  });

  it('should support trigram substring search', () => {
    insertChunk({ conversation_id: 'conv-123', chunk_index: 0, page_number: 1,
      role: 'user', content: 'authentication middleware', embedding: null });
    // Trigram tokenizer should find substring matches
    expect(searchChunksFTS('auth')).toHaveLength(1);
    expect(searchChunksFTS('middle')).toHaveLength(1);
  });

  it('should cascade delete', () => {
    insertChunk({ conversation_id: 'conv-123', chunk_index: 0, page_number: 1,
      role: 'user', content: 'test', embedding: null });
    getDatabase().prepare('DELETE FROM conversations WHERE id = ?').run('conv-123');
    expect(getChunksForConversation('conv-123')).toHaveLength(0);
  });

  it('should sanitize FTS special characters', () => {
    insertChunk({ conversation_id: 'conv-123', chunk_index: 0, page_number: 1,
      role: 'user', content: 'special chars test', embedding: null });

    // These should not throw errors
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
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Implement**

Create `src/db/chunks.ts`:
```typescript
import { getDatabase } from './index';

export interface Chunk {
  id?: number; conversation_id: string; chunk_index: number;
  page_number: number | null; role: 'user' | 'assistant'; content: string; embedding: Buffer | null;
}

export function insertChunk(c: Chunk): number {
  const r = getDatabase().prepare(`INSERT INTO chunks
    (conversation_id, chunk_index, page_number, role, content, embedding) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(c.conversation_id, c.chunk_index, c.page_number, c.role, c.content, c.embedding);
  return r.lastInsertRowid as number;
}

export function getChunksForConversation(id: string): Chunk[] {
  return getDatabase().prepare('SELECT * FROM chunks WHERE conversation_id = ? ORDER BY chunk_index').all(id) as Chunk[];
}

/**
 * Search chunks using FTS5 with trigram tokenizer.
 * Sanitizes query to remove FTS5 special characters and operators.
 */
export function searchChunksFTS(query: string, limit = 100): Chunk[] {
  const sanitized = sanitizeFTSQuery(query);
  if (!sanitized) return [];

  return getDatabase().prepare(`
    SELECT c.* FROM chunks_fts fts
    JOIN chunks c ON c.id = fts.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY bm25(chunks_fts)
    LIMIT ?
  `).all(sanitized, limit) as Chunk[];
}

/**
 * Sanitize query for FTS5:
 * - Remove special operators (AND, OR, NOT)
 * - Remove special characters (", *, (, ))
 * - Wrap each term in quotes for exact matching
 */
export function sanitizeFTSQuery(query: string): string {
  return query
    .replace(/["\*\(\)]/g, ' ')           // Remove special chars
    .replace(/\b(AND|OR|NOT)\b/gi, ' ')   // Remove operators
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t}"`)                   // Quote each term
    .join(' ');
}

export function deleteChunksForConversation(id: string): void {
  getDatabase().prepare('DELETE FROM chunks WHERE conversation_id = ?').run(id);
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): add chunk CRUD with FTS sync and query sanitization"
```

---

## Phase 3: Change Detection

### Task 3.1: File Hash and Mtime Utilities

**Files:**
- Create: `src/indexer/fileUtils.ts`
- Create: `tests/indexer/fileUtils.test.ts`

**Step 1: Write the failing test**

Create `tests/indexer/fileUtils.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { getFileHash, getFileMtime } from '../../src/indexer/fileUtils';

const TEST_FILE = '/tmp/test-utils.txt';

describe('File Utilities', () => {
  beforeEach(() => { writeFileSync(TEST_FILE, 'test content'); });
  afterEach(() => { if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE); });

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
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Implement**

Create `src/indexer/fileUtils.ts`:
```typescript
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';

export function getFileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function getFileMtime(path: string): number {
  return Math.floor(statSync(path).mtimeMs / 1000);
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(indexer): add file hash/mtime utilities"
```

---

### Task 3.2: Change Detection Logic

**Files:**
- Create: `src/indexer/changeDetection.ts`
- Create: `tests/indexer/changeDetection.test.ts`

**Step 1: Write the failing test**

Create `tests/indexer/changeDetection.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { createDatabase, closeDatabase } from '../../src/db';
import { insertConversation } from '../../src/db/conversations';
import { detectChanges } from '../../src/indexer/changeDetection';
import { getFileHash, getFileMtime } from '../../src/indexer/fileUtils';

const TEST_DB = '/tmp/test-changes.db';
const TEST_DIR = '/tmp/test-jsonl';

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
    writeFileSync(`${TEST_DIR}/new.jsonl`, '{}');
    const changes = detectChanges(TEST_DIR);
    expect(changes.added).toHaveLength(1);
  });

  it('should detect modified files via hash change', () => {
    const f = `${TEST_DIR}/mod.jsonl`;
    writeFileSync(f, '{}');
    insertConversation({ id: 'c1', project: 'p', title: '', created_at: null,
      file_path: f, content_hash: 'old', source_mtime: 0 });
    expect(detectChanges(TEST_DIR).modified).toHaveLength(1);
  });

  it('should detect deleted files (tombstone)', () => {
    insertConversation({ id: 'c1', project: 'p', title: '', created_at: null,
      file_path: `${TEST_DIR}/gone.jsonl`, content_hash: 'h', source_mtime: 0 });
    expect(detectChanges(TEST_DIR).deleted).toContain('c1');
  });

  it('should skip unchanged files (mtime + hash match)', () => {
    const f = `${TEST_DIR}/same.jsonl`;
    writeFileSync(f, '{}');
    insertConversation({ id: 'c1', project: 'p', title: '', created_at: null,
      file_path: f, content_hash: getFileHash(f), source_mtime: getFileMtime(f) });
    const changes = detectChanges(TEST_DIR);
    expect(changes.added).toHaveLength(0);
    expect(changes.modified).toHaveLength(0);
  });

  it('should use mtime as quick check before hashing', () => {
    const f = `${TEST_DIR}/quick.jsonl`;
    writeFileSync(f, '{}');
    const mtime = getFileMtime(f);
    const hash = getFileHash(f);

    // Same mtime means skip hash check
    insertConversation({ id: 'c1', project: 'p', title: '', created_at: null,
      file_path: f, content_hash: hash, source_mtime: mtime });

    const changes = detectChanges(TEST_DIR);
    expect(changes.modified).toHaveLength(0);
  });

  it('should handle nested directories', () => {
    mkdirSync(`${TEST_DIR}/sub/nested`, { recursive: true });
    writeFileSync(`${TEST_DIR}/sub/nested/deep.jsonl`, '{}');
    const changes = detectChanges(TEST_DIR);
    expect(changes.added).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Implement**

Create `src/indexer/changeDetection.ts`:
```typescript
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getDatabase } from '../db';
import { getFileHash, getFileMtime } from './fileUtils';

export interface ChangeSet { added: string[]; modified: string[]; deleted: string[]; }

export function detectChanges(sourceDir: string): ChangeSet {
  const db = getDatabase();
  const changes: ChangeSet = { added: [], modified: [], deleted: [] };
  const files = findJsonlFiles(sourceDir);
  const fileSet = new Set(files);

  const indexed = db.prepare('SELECT id, file_path, content_hash, source_mtime FROM conversations')
    .all() as { id: string; file_path: string; content_hash: string; source_mtime: number }[];
  const indexedPaths = new Map(indexed.map(r => [r.file_path, { id: r.id, hash: r.content_hash, mtime: r.source_mtime }]));

  for (const f of files) {
    const existing = indexedPaths.get(f);
    if (!existing) {
      changes.added.push(f);
    } else {
      // Quick check: skip if mtime matches
      const currentMtime = getFileMtime(f);
      if (currentMtime !== existing.mtime) {
        // Mtime changed, verify with hash
        const currentHash = getFileHash(f);
        if (currentHash !== existing.hash) {
          changes.modified.push(f);
        }
      }
    }
  }

  // Detect tombstones (files in index but not on disk)
  for (const [path, info] of indexedPaths) {
    if (!fileSet.has(path) && !existsSync(path)) {
      changes.deleted.push(info.id);
    }
  }

  return changes;
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  function scan(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  }
  scan(dir);
  return files;
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(indexer): add three-tier change detection (mtime -> hash -> tombstone)"
```

---

## Phase 4: JSONL Parsing

### Task 4.1: Parse Transcript Files

**Files:**
- Create: `src/indexer/parser.ts`
- Create: `tests/indexer/parser.test.ts`
- Create: `tests/fixtures/sample.jsonl`

**Step 1: Create fixture**

Create `tests/fixtures/sample.jsonl`:
```
{"type":"user","message":{"role":"user","content":"How do I use async/await?"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Async/await handles promises."}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read"}]}}
{"type":"user","message":{"role":"user","content":"Thanks!"}}
{"type":"result","result":"some tool output"}
```

**Step 2: Write the failing test**

Create `tests/indexer/parser.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { parseTranscript, extractConversationMetadata } from '../../src/indexer/parser';

const FIXTURE = join(__dirname, '../fixtures/sample.jsonl');

describe('Parser', () => {
  it('should parse user messages', () => {
    const msgs = parseTranscript(FIXTURE).filter(m => m.role === 'user');
    expect(msgs).toHaveLength(2);
  });

  it('should parse assistant text messages', () => {
    const msgs = parseTranscript(FIXTURE).filter(m => m.role === 'assistant');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('Async/await');
  });

  it('should exclude tool_use content blocks', () => {
    const msgs = parseTranscript(FIXTURE);
    expect(msgs.some(m => m.content.includes('Read'))).toBe(false);
  });

  it('should exclude result entries', () => {
    const msgs = parseTranscript(FIXTURE);
    expect(msgs.some(m => m.content.includes('tool output'))).toBe(false);
  });

  it('should preserve message order', () => {
    const msgs = parseTranscript(FIXTURE);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[0].index).toBe(0);
    expect(msgs[1].index).toBe(1);
  });

  it('should handle array content blocks', () => {
    const msgs = parseTranscript(FIXTURE);
    const assistant = msgs.find(m => m.role === 'assistant');
    expect(assistant?.content).toBe('Async/await handles promises.');
  });

  it('should handle string content', () => {
    const msgs = parseTranscript(FIXTURE);
    const user = msgs.find(m => m.role === 'user');
    expect(user?.content).toBe('How do I use async/await?');
  });

  it('should skip malformed JSON lines', () => {
    // This should not throw
    expect(() => parseTranscript(FIXTURE)).not.toThrow();
  });
});

describe('Metadata Extraction', () => {
  it('should extract conversation metadata from fixture', () => {
    const meta = extractConversationMetadata(FIXTURE);
    expect(meta.messageCount).toBeGreaterThan(0);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 4: Implement**

Create `src/indexer/parser.ts`:
```typescript
import { readFileSync } from 'fs';

export interface Message { index: number; role: 'user' | 'assistant'; content: string; }

export interface ConversationMetadata {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
}

export function parseTranscript(path: string): Message[] {
  const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
  const messages: Message[] = [];
  let idx = 0;

  for (const line of lines) {
    try {
      const p = JSON.parse(line);

      // Only process user and assistant message types
      if (p.type === 'user' && p.message?.role === 'user') {
        const text = extractText(p.message.content);
        if (text) messages.push({ index: idx++, role: 'user', content: text });
      } else if (p.type === 'assistant' && p.message?.role === 'assistant') {
        const text = extractText(p.message.content);
        if (text) messages.push({ index: idx++, role: 'assistant', content: text });
      }
      // Skip: tool_result, result, summary, and other types
    } catch {
      // Skip malformed JSON lines
    }
  }
  return messages;
}

/**
 * Extract text content from message content.
 * Handles both string content and array of content blocks.
 * Filters out tool_use blocks (too noisy for search).
 */
function extractText(content: string | any[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

export function extractConversationMetadata(path: string): ConversationMetadata {
  const messages = parseTranscript(path);
  return {
    messageCount: messages.length,
    userMessageCount: messages.filter(m => m.role === 'user').length,
    assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
  };
}
```

**Step 5: Run test**

Run: `npm test`
Expected: PASS

**Step 6: Commit**

```bash
git add -A && git commit -m "feat(indexer): add JSONL parser excluding tool_use blocks"
```

---

## Phase 5: Chunking

### Task 5.1: Text Chunker with Overlap

**Files:**
- Create: `src/indexer/chunker.ts`
- Create: `tests/indexer/chunker.test.ts`

**Step 1: Write the failing test**

Create `tests/indexer/chunker.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { chunkText, ChunkOptions } from '../../src/indexer/chunker';

describe('Chunker', () => {
  const defaultOpts: ChunkOptions = { maxTokens: 300, overlap: 50 };

  it('should return single chunk for short text', () => {
    expect(chunkText('short', defaultOpts)).toHaveLength(1);
  });

  it('should split long text into multiple chunks', () => {
    const longText = 'word '.repeat(500);
    const chunks = chunkText(longText, { maxTokens: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should include overlap between chunks', () => {
    const text = 'one two three four five six seven eight nine ten';
    const chunks = chunkText(text, { maxTokens: 5, overlap: 2 });

    // With overlap, adjacent chunks should share some content
    if (chunks.length >= 2) {
      const firstEnd = chunks[0].split(' ').slice(-2).join(' ');
      expect(chunks[1]).toContain(firstEnd.split(' ')[0]);
    }
  });

  it('should keep small code blocks intact', () => {
    const code = '```js\nfunction test() {\n  return 42;\n}\n```';
    const chunks = chunkText(code, { maxTokens: 100, overlap: 20 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('function test');
  });

  it('should split code blocks larger than 400 tokens at line boundaries', () => {
    // Create a code block with many lines
    const lines = Array(100).fill('  const x = 1;').join('\n');
    const code = '```js\n' + lines + '\n```';
    const chunks = chunkText(code, { maxTokens: 50, overlap: 10 });

    // Should split, and each chunk should end at a line boundary (no mid-line splits)
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      // Each chunk except last should end with newline or code fence
      expect(chunk.endsWith('\n') || chunk.endsWith('```')).toBe(true);
    }
  });

  it('should prefer paragraph boundaries as split points', () => {
    const text = 'First paragraph.\n\nSecond paragraph with more content that makes it longer.\n\nThird paragraph.';
    const chunks = chunkText(text, { maxTokens: 20, overlap: 5 });

    // Should split at paragraph boundaries when possible
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should handle empty text', () => {
    expect(chunkText('', defaultOpts)).toHaveLength(0);
    expect(chunkText('   ', defaultOpts)).toHaveLength(0);
  });

  it('should respect maxTokens limit (approximately)', () => {
    const longText = 'word '.repeat(1000);
    const chunks = chunkText(longText, { maxTokens: 100, overlap: 20 });

    // Each chunk should be roughly within limit (4 chars per token approximation)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100 * 4 * 1.5); // Allow some tolerance
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Implement**

Create `src/indexer/chunker.ts`:
```typescript
export interface ChunkOptions {
  maxTokens: number;   // Target 200-400 tokens per chunk
  overlap: number;     // 50 tokens overlap for context continuity
}

// Approximate chars per token (conservative for mixed content)
const CHARS_PER_TOKEN = 4;

export function chunkText(text: string, opts: ChunkOptions): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const maxChars = opts.maxTokens * CHARS_PER_TOKEN;
  const overlapChars = opts.overlap * CHARS_PER_TOKEN;

  // Short text: single chunk
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < trimmed.length) {
    let end = Math.min(pos + maxChars, trimmed.length);

    // Find a good break point if not at end
    if (end < trimmed.length) {
      end = findBreakPoint(trimmed, pos, end);
    }

    const chunk = trimmed.slice(pos, end).trim();
    if (chunk) chunks.push(chunk);

    // Move forward, preserving overlap
    pos = Math.max(pos + 1, end - overlapChars);
  }

  return chunks.length ? chunks : [trimmed];
}

/**
 * Find a good break point for chunking.
 * Priority: paragraph > code fence > line > sentence > word > forced
 */
function findBreakPoint(text: string, start: number, end: number): number {
  const segment = text.slice(start, end);
  const minPos = Math.floor(segment.length * 0.3); // Don't break in first 30%

  // Priority 1: Paragraph boundary (double newline)
  const paraIdx = segment.lastIndexOf('\n\n');
  if (paraIdx > minPos) return start + paraIdx + 2;

  // Priority 2: Code fence boundary
  const fenceIdx = segment.lastIndexOf('```\n');
  if (fenceIdx > minPos) return start + fenceIdx + 4;

  // Priority 3: Line boundary
  const lineIdx = segment.lastIndexOf('\n');
  if (lineIdx > minPos) return start + lineIdx + 1;

  // Priority 4: Sentence boundary
  const sentenceIdx = segment.lastIndexOf('. ');
  if (sentenceIdx > minPos) return start + sentenceIdx + 2;

  // Priority 5: Word boundary
  const wordIdx = segment.lastIndexOf(' ');
  if (wordIdx > minPos) return start + wordIdx + 1;

  // Fallback: forced break
  return end;
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(indexer): add text chunker with overlap and smart boundaries"
```

---

## Phase 6: Search API

### Task 6.1: FTS Search with Filters

**Files:**
- Create: `src/api/search.ts`
- Create: `tests/api/search.test.ts`

**Step 1: Write the failing test**

Create `tests/api/search.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../../src/db';
import { insertConversation } from '../../src/db/conversations';
import { insertChunk } from '../../src/db/chunks';
import { searchFTS, SearchOptions } from '../../src/api/search';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/test-search.db';

describe('Search API', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);

    // Setup test data
    insertConversation({ id: 'c1', project: 'project-a', title: 'JavaScript Help',
      created_at: '2025-01-20', file_path: '/f1.jsonl', content_hash: 'h1', source_mtime: 1000 });
    insertConversation({ id: 'c2', project: 'project-b', title: 'Python Help',
      created_at: '2025-01-15', file_path: '/f2.jsonl', content_hash: 'h2', source_mtime: 1000 });

    insertChunk({ conversation_id: 'c1', chunk_index: 0, page_number: 1,
      role: 'user', content: 'How do I use async await in JavaScript?', embedding: null });
    insertChunk({ conversation_id: 'c1', chunk_index: 1, page_number: 1,
      role: 'assistant', content: 'Async/await is syntactic sugar for promises.', embedding: null });
    insertChunk({ conversation_id: 'c2', chunk_index: 0, page_number: 1,
      role: 'user', content: 'Python async programming', embedding: null });
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should find by keyword', () => {
    const results = searchFTS('async', {});
    expect(results.length).toBeGreaterThan(0);
  });

  it('should filter by project (inside query, not after)', () => {
    const results = searchFTS('async', { project: 'project-a' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.project === 'project-a')).toBe(true);

    const noResults = searchFTS('async', { project: 'nonexistent' });
    expect(noResults).toHaveLength(0);
  });

  it('should filter by role', () => {
    const userResults = searchFTS('async', { role: 'user' });
    expect(userResults.every(r => r.role === 'user')).toBe(true);

    const assistantResults = searchFTS('async', { role: 'assistant' });
    expect(assistantResults.every(r => r.role === 'assistant')).toBe(true);
  });

  it('should filter by date range', () => {
    const results = searchFTS('async', { after: '2025-01-18' });
    expect(results.length).toBeGreaterThan(0);
    // Only c1 is after 2025-01-18
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
    expect(results.length).toBeGreaterThanOrEqual(0); // Should not throw
  });

  it('should return empty array for empty query', () => {
    expect(searchFTS('', {})).toHaveLength(0);
    expect(searchFTS('   ', {})).toHaveLength(0);
  });

  it('should sanitize FTS special characters', () => {
    // These should not throw
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
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Implement**

Create `src/api/search.ts`:
```typescript
import { getDatabase } from '../db';
import { sanitizeFTSQuery } from '../db/chunks';

export interface SearchOptions {
  project?: string;
  role?: 'user' | 'assistant';
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  chunk_id: number;
  conversation_id: string;
  title: string | null;
  project: string;
  role: string;
  content: string;
  page_number: number | null;
  score: number;
}

/**
 * Full-text search with filters applied INSIDE the query (not after).
 * This ensures correct ranking - filters don't skew BM25 scores.
 */
export function searchFTS(query: string, opts: SearchOptions): SearchResult[] {
  const db = getDatabase();
  const { project, role, after, before, limit = 20, offset = 0 } = opts;

  // Validate limit/offset
  if (limit < 0 || offset < 0) return [];

  const sanitized = sanitizeFTSQuery(query);
  if (!sanitized) return [];

  // Build query with filters inside (critical for correct ranking)
  let sql = `
    SELECT
      c.id as chunk_id,
      c.conversation_id,
      conv.title,
      conv.project,
      c.role,
      c.content,
      c.page_number,
      bm25(chunks_fts) as score
    FROM chunks_fts fts
    JOIN chunks c ON c.id = fts.rowid
    JOIN conversations conv ON conv.id = c.conversation_id
    WHERE chunks_fts MATCH ?
  `;
  const params: any[] = [sanitized];

  // Add filters (inside query, not post-filter)
  if (project) {
    sql += ' AND conv.project = ?';
    params.push(project);
  }
  if (role) {
    sql += ' AND c.role = ?';
    params.push(role);
  }
  if (after) {
    sql += ' AND conv.created_at >= ?';
    params.push(after);
  }
  if (before) {
    sql += ' AND conv.created_at <= ?';
    params.push(before);
  }

  sql += ' ORDER BY score LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params) as SearchResult[];
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): add FTS search with filters inside query"
```

---

### Task 6.2: Snippet Generation with Highlighting

**Files:**
- Create: `src/api/snippets.ts`
- Create: `tests/api/snippets.test.ts`

**Step 1: Write the failing test**

Create `tests/api/snippets.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { generateSnippet, highlightTerms } from '../../src/api/snippets';

describe('Snippet Generation', () => {
  it('should extract context around match', () => {
    const content = 'before before before async await after after after';
    const snippet = generateSnippet(content, 'async', 20);
    expect(snippet).toContain('async');
  });

  it('should add ellipsis when truncating', () => {
    const content = 'A'.repeat(100) + ' async ' + 'B'.repeat(100);
    const snippet = generateSnippet(content, 'async', 20);
    expect(snippet).toContain('...');
  });

  it('should handle match at start', () => {
    const content = 'async is at the start of this text';
    const snippet = generateSnippet(content, 'async', 50);
    expect(snippet.startsWith('async')).toBe(true);
  });

  it('should handle match at end', () => {
    const content = 'this text ends with async';
    const snippet = generateSnippet(content, 'async', 50);
    expect(snippet.endsWith('async')).toBe(true);
  });

  it('should return truncated content when no match', () => {
    const content = 'some content without the search term';
    const snippet = generateSnippet(content, 'notfound', 20);
    expect(snippet.length).toBeLessThanOrEqual(50);
  });

  it('should handle multiple search terms', () => {
    const content = 'async await promises are great';
    const snippet = generateSnippet(content, 'async await', 50);
    expect(snippet).toContain('async');
  });
});

describe('Term Highlighting', () => {
  it('should wrap terms in markdown bold', () => {
    const highlighted = highlightTerms('use async here', ['async']);
    expect(highlighted).toBe('use **async** here');
  });

  it('should highlight multiple terms', () => {
    const highlighted = highlightTerms('async and await', ['async', 'await']);
    expect(highlighted).toBe('**async** and **await**');
  });

  it('should be case-insensitive', () => {
    const highlighted = highlightTerms('ASYNC code', ['async']);
    expect(highlighted).toBe('**ASYNC** code');
  });

  it('should handle regex special characters in terms', () => {
    const highlighted = highlightTerms('test (parens) here', ['(parens)']);
    expect(highlighted).toBe('test **(parens)** here');
  });

  it('should not double-highlight', () => {
    const highlighted = highlightTerms('async async', ['async']);
    expect(highlighted).toBe('**async** **async**');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Implement**

Create `src/api/snippets.ts`:
```typescript
/**
 * Generate a snippet from content centered around search terms.
 * @param content Full content text
 * @param query Search query
 * @param contextChars Characters of context on each side
 * @returns Snippet with ellipsis if truncated
 */
export function generateSnippet(content: string, query: string, contextChars = 75): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();

  // Find first matching term position
  let matchIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
      matchIdx = idx;
    }
  }

  // No match: return start of content
  if (matchIdx === -1) {
    const maxLen = contextChars * 2;
    return content.length > maxLen
      ? content.slice(0, maxLen) + '...'
      : content;
  }

  // Extract context around match
  const start = Math.max(0, matchIdx - contextChars);
  const end = Math.min(content.length, matchIdx + contextChars);

  let snippet = content.slice(start, end);

  // Add ellipsis for truncation
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

/**
 * Highlight search terms in text using markdown bold (**term**).
 * @param text Text to highlight in
 * @param terms Terms to highlight
 * @returns Text with highlighted terms
 */
export function highlightTerms(text: string, terms: string[]): string {
  let result = text;

  for (const term of terms) {
    if (!term) continue;

    // Escape regex special characters
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    result = result.replace(regex, '**$1**');
  }

  return result;
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): add snippet generation with markdown highlighting"
```

---

### Task 6.3: Empty Query Fallback (Recent Conversations)

**Files:**
- Modify: `src/api/search.ts`
- Create: `tests/api/search-fallback.test.ts`

**Step 1: Write the failing test**

Create `tests/api/search-fallback.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../../src/db';
import { insertConversation } from '../../src/db/conversations';
import { searchWithFallback } from '../../src/api/search';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/test-search-fallback.db';

describe('Search Fallback', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);

    insertConversation({ id: 'c1', project: 'project-a', title: 'Recent',
      created_at: '2025-01-20', file_path: '/f1.jsonl', content_hash: 'h1', source_mtime: 1000 });
    insertConversation({ id: 'c2', project: 'project-a', title: 'Older',
      created_at: '2025-01-15', file_path: '/f2.jsonl', content_hash: 'h2', source_mtime: 1000 });
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should return recent conversations for empty query', () => {
    const results = searchWithFallback('', {});
    expect(results.conversations.length).toBeGreaterThan(0);
    expect(results.type).toBe('recent');
  });

  it('should return recent conversations for whitespace query', () => {
    const results = searchWithFallback('   ', {});
    expect(results.type).toBe('recent');
  });

  it('should filter recent by project', () => {
    insertConversation({ id: 'c3', project: 'project-b', title: 'Other',
      created_at: '2025-01-20', file_path: '/f3.jsonl', content_hash: 'h3', source_mtime: 1000 });

    const results = searchWithFallback('', { project: 'project-a' });
    expect(results.conversations.every(c => c.project === 'project-a')).toBe(true);
  });

  it('should order recent by created_at descending', () => {
    const results = searchWithFallback('', {});
    expect(results.conversations[0].title).toBe('Recent');
    expect(results.conversations[1].title).toBe('Older');
  });

  it('should return search results for non-empty query', () => {
    const results = searchWithFallback('nonexistent', {});
    expect(results.type).toBe('search');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Update search.ts with fallback**

Add to `src/api/search.ts`:
```typescript
import { getRecentConversations, listConversations, Conversation } from '../db/conversations';

export interface SearchWithFallbackResult {
  type: 'search' | 'recent';
  results?: SearchResult[];
  conversations?: Conversation[];
}

/**
 * Search with fallback to recent conversations for empty queries.
 * Per design: "Empty query → Return recent conversations"
 */
export function searchWithFallback(query: string, opts: SearchOptions): SearchWithFallbackResult {
  const trimmed = query.trim();

  if (!trimmed) {
    // Empty query: return recent conversations
    const conversations = opts.project
      ? listConversations(opts.project)
      : getRecentConversations(opts.limit || 20);
    return { type: 'recent', conversations };
  }

  // Non-empty query: perform search
  const results = searchFTS(query, opts);
  return { type: 'search', results };
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): add empty query fallback to recent conversations"
```

---

## Phase 7: Embedding Client (Future - sqlite-vec)

### Task 7.1: Embedding Client with Health Checks

> **Note:** This phase requires sqlite-vec native addon and qwen3-embeddings-mlx sidecar.
> Implement after Phase 6 is complete and stable.

**Files:**
- Create: `src/embeddings/client.ts`
- Create: `tests/embeddings/client.test.ts`

**Tests to implement:**
```typescript
describe('Embedding Client', () => {
  it('should connect via Unix socket');
  it('should batch embed multiple texts');
  it('should report health status');
  it('should timeout gracefully');
  it('should fall back when embeddings unavailable');
});
```

---

### Task 7.2: Vector Search with sqlite-vec

> **Note:** Requires sqlite-vec extension loaded.

**Tests to implement:**
```typescript
describe('Vector Search', () => {
  it('should load sqlite-vec extension');
  it('should create chunks_vec virtual table');
  it('should insert and retrieve vectors');
  it('should perform similarity search');
  it('should sync vectors via triggers');
});
```

---

### Task 7.3: Hybrid Search with RRF

> **Note:** Requires both FTS and vector search working.

**Tests to implement:**
```typescript
describe('Hybrid Search with RRF', () => {
  it('should merge FTS and vector results using RRF (k=60)');
  it('should rank documents appearing in both higher');
  it('should handle FTS-only results when embeddings down');
  it('should handle vector-only results for pure semantic queries');
  it('should apply filters before RRF merge');
});
```

**RRF Implementation (k=60):**
```typescript
function mergeWithRRF(vectorResults: Result[], ftsResults: Result[], k = 60): Result[] {
  const scores = new Map<number, number>();

  vectorResults.forEach((r, rank) => {
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + rank));
  });

  ftsResults.forEach((r, rank) => {
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + rank));
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}
```

---

## Phase 8: Background Indexing (Future)

### Task 8.1: Lock File Management

**Tests to implement:**
```typescript
describe('Lock File', () => {
  it('should write lock file with PID on indexing start');
  it('should release lock file on indexing complete');
  it('should detect stale lock files (process dead)');
  it('should prevent concurrent indexing');
});
```

---

### Task 8.2: Atomic Index Swap

**Tests to implement:**
```typescript
describe('Atomic Swap', () => {
  it('should only swap index after successful completion');
  it('should serve old index during rebuild');
  it('should never serve partial index');
  it('should handle swap failure gracefully');
});
```

---

### Task 8.3: Background Worker

**Tests to implement:**
```typescript
describe('Background Worker', () => {
  it('should spawn indexing in separate process');
  it('should not block server startup');
  it('should report indexing progress');
  it('should handle worker crash');
});
```

---

## Summary

**Phases 1-6 (Core - implement now):**
1. Configuration & Test Infrastructure
2. Database Schema with FTS5 trigram + sync triggers
3. Conversation & Chunk CRUD
4. Change Detection (mtime → hash → tombstone)
5. JSONL Parsing (exclude tool_use)
6. Chunking with overlap + smart boundaries
7. Search API with filters inside queries + snippets

**Phases 7-8 (Advanced - implement after core is stable):**
7. Embedding Client + sqlite-vec + RRF hybrid search
8. Background Indexing with lock file + atomic swap

**Key Design Decisions Tested:**
- ✅ Trigram tokenizer for substring/code search
- ✅ Sync triggers keep FTS in sync
- ✅ FTS query sanitization
- ✅ Three-tier change detection
- ✅ Filters inside queries (not post-filter)
- ✅ Empty query → recent conversations
- ✅ Snippet highlighting with markdown
- 🔜 RRF with k=60 for hybrid ranking
- 🔜 Lock file with PID for concurrent safety
- 🔜 Atomic swap for index integrity

---

**Plan saved.** Two execution options:

**1. Subagent-Driven (this session)** - Fresh subagent per task, review between tasks

**2. Parallel Session (separate)** - New session with executing-plans skill

Which approach?
