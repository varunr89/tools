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

## Phase 1: Test Infrastructure Setup

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

  it('should create virtual tables for search', () => {
    createDatabase(TEST_DB);
    const db = getDatabase();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain('chunks_fts');
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

export const FTS_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='trigram'
);
`;

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
git add -A && git commit -m "feat(db): add database schema with FTS5 support"
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
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): add conversation CRUD"
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

  it('should cascade delete', () => {
    insertChunk({ conversation_id: 'conv-123', chunk_index: 0, page_number: 1,
      role: 'user', content: 'test', embedding: null });
    getDatabase().prepare('DELETE FROM conversations WHERE id = ?').run('conv-123');
    expect(getChunksForConversation('conv-123')).toHaveLength(0);
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

export function searchChunksFTS(query: string, limit = 100): Chunk[] {
  const sanitized = query.replace(/["\*\(\)]/g, ' ').replace(/\b(AND|OR|NOT)\b/gi, ' ')
    .trim().split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' ');
  if (!sanitized) return [];
  return getDatabase().prepare(`SELECT c.* FROM chunks_fts fts JOIN chunks c ON c.id = fts.rowid
    WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`).all(sanitized, limit) as Chunk[];
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
git add -A && git commit -m "feat(db): add chunk CRUD with FTS sync"
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

  it('should get mtime', () => {
    expect(getFileMtime(TEST_FILE)).toBeGreaterThan(0);
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

  it('should detect modified files', () => {
    const f = `${TEST_DIR}/mod.jsonl`;
    writeFileSync(f, '{}');
    insertConversation({ id: 'c1', project: 'p', title: '', created_at: null,
      file_path: f, content_hash: 'old', source_mtime: 0 });
    expect(detectChanges(TEST_DIR).modified).toHaveLength(1);
  });

  it('should detect deleted files', () => {
    insertConversation({ id: 'c1', project: 'p', title: '', created_at: null,
      file_path: `${TEST_DIR}/gone.jsonl`, content_hash: 'h', source_mtime: 0 });
    expect(detectChanges(TEST_DIR).deleted).toContain('c1');
  });

  it('should skip unchanged', () => {
    const f = `${TEST_DIR}/same.jsonl`;
    writeFileSync(f, '{}');
    insertConversation({ id: 'c1', project: 'p', title: '', created_at: null,
      file_path: f, content_hash: getFileHash(f), source_mtime: getFileMtime(f) });
    const changes = detectChanges(TEST_DIR);
    expect(changes.added).toHaveLength(0);
    expect(changes.modified).toHaveLength(0);
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
    if (!existing) { changes.added.push(f); }
    else if (getFileMtime(f) !== existing.mtime && getFileHash(f) !== existing.hash) {
      changes.modified.push(f);
    }
  }

  for (const [path, info] of indexedPaths) {
    if (!fileSet.has(path) && !existsSync(path)) changes.deleted.push(info.id);
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
git add -A && git commit -m "feat(indexer): add change detection"
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
```

**Step 2: Write the failing test**

Create `tests/indexer/parser.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { parseTranscript } from '../../src/indexer/parser';

const FIXTURE = join(__dirname, '../fixtures/sample.jsonl');

describe('Parser', () => {
  it('should parse user messages', () => {
    const msgs = parseTranscript(FIXTURE).filter(m => m.role === 'user');
    expect(msgs).toHaveLength(2);
  });

  it('should exclude tool_use', () => {
    const msgs = parseTranscript(FIXTURE);
    expect(msgs.some(m => m.content.includes('Read'))).toBe(false);
  });

  it('should preserve order', () => {
    const msgs = parseTranscript(FIXTURE);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
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

export function parseTranscript(path: string): Message[] {
  const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
  const messages: Message[] = [];
  let idx = 0;

  for (const line of lines) {
    try {
      const p = JSON.parse(line);
      if (p.type === 'user' && p.message?.role === 'user') {
        const text = extractText(p.message.content);
        if (text) messages.push({ index: idx++, role: 'user', content: text });
      } else if (p.type === 'assistant' && p.message?.role === 'assistant') {
        const text = extractText(p.message.content);
        if (text) messages.push({ index: idx++, role: 'assistant', content: text });
      }
    } catch {}
  }
  return messages;
}

function extractText(content: string | any[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
  }
  return '';
}
```

**Step 5: Run test**

Run: `npm test`
Expected: PASS

**Step 6: Commit**

```bash
git add -A && git commit -m "feat(indexer): add JSONL parser"
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
import { chunkText } from '../../src/indexer/chunker';

describe('Chunker', () => {
  it('should return single chunk for short text', () => {
    expect(chunkText('short', { maxTokens: 100, overlap: 20 })).toHaveLength(1);
  });

  it('should split long text', () => {
    expect(chunkText('word '.repeat(200), { maxTokens: 50, overlap: 10 }).length).toBeGreaterThan(1);
  });

  it('should keep code blocks together', () => {
    const code = '```js\nfunc()\n```';
    expect(chunkText(code, { maxTokens: 50, overlap: 10 })).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Implement**

Create `src/indexer/chunker.ts`:
```typescript
export interface ChunkOptions { maxTokens: number; overlap: number; }

const CHARS_PER_TOKEN = 4;

export function chunkText(text: string, opts: ChunkOptions): string[] {
  const maxChars = opts.maxTokens * CHARS_PER_TOKEN;
  const overlapChars = opts.overlap * CHARS_PER_TOKEN;

  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    let end = Math.min(pos + maxChars, text.length);
    if (end < text.length) end = findBreak(text, pos, end);
    const chunk = text.slice(pos, end).trim();
    if (chunk) chunks.push(chunk);
    pos = Math.max(pos + 1, end - overlapChars);
  }

  return chunks.length ? chunks : [text];
}

function findBreak(text: string, start: number, end: number): number {
  const seg = text.slice(start, end);
  for (const sep of ['\n\n', '```\n', '\n', '. ', ' ']) {
    const idx = seg.lastIndexOf(sep);
    if (idx > seg.length * 0.3) return start + idx + sep.length;
  }
  return end;
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(indexer): add text chunker with overlap"
```

---

## Phase 6: Search API

### Task 6.1: FTS Search Endpoint

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
import { searchHybrid } from '../../src/api/search';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/test-search.db';

describe('Search', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);
    insertConversation({ id: 'c1', project: 'p', title: 'JS', created_at: '2025-01-20',
      file_path: '/f.jsonl', content_hash: 'h', source_mtime: 1000 });
    insertChunk({ conversation_id: 'c1', chunk_index: 0, page_number: 1,
      role: 'user', content: 'async await question', embedding: null });
  });

  afterEach(() => { closeDatabase(); if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

  it('should find by keyword', () => {
    expect(searchHybrid('async', {}).length).toBeGreaterThan(0);
  });

  it('should filter by project', () => {
    const r = searchHybrid('async', { project: 'other' });
    expect(r).toHaveLength(0);
  });

  it('should respect limit', () => {
    insertChunk({ conversation_id: 'c1', chunk_index: 1, page_number: 1,
      role: 'assistant', content: 'async response', embedding: null });
    expect(searchHybrid('async', { limit: 1 })).toHaveLength(1);
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

export interface SearchOptions {
  project?: string; role?: 'user' | 'assistant';
  after?: string; before?: string; limit?: number; offset?: number;
}

export interface SearchResult {
  chunk_id: number; conversation_id: string; title: string | null;
  project: string; role: string; content: string; page_number: number | null; score: number;
}

export function searchHybrid(query: string, opts: SearchOptions): SearchResult[] {
  const db = getDatabase();
  const { project, role, after, before, limit = 20, offset = 0 } = opts;

  const sanitized = query.replace(/["\*\(\)]/g, ' ').replace(/\b(AND|OR|NOT)\b/gi, ' ')
    .trim().split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' ');
  if (!sanitized) return [];

  let sql = `SELECT c.id as chunk_id, c.conversation_id, conv.title, conv.project,
    c.role, c.content, c.page_number, bm25(chunks_fts) as score
    FROM chunks_fts fts JOIN chunks c ON c.id = fts.rowid
    JOIN conversations conv ON conv.id = c.conversation_id WHERE chunks_fts MATCH ?`;
  const params: any[] = [sanitized];

  if (project) { sql += ' AND conv.project = ?'; params.push(project); }
  if (role) { sql += ' AND c.role = ?'; params.push(role); }
  if (after) { sql += ' AND conv.created_at >= ?'; params.push(after); }
  if (before) { sql += ' AND conv.created_at <= ?'; params.push(before); }

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
git add -A && git commit -m "feat(api): add FTS search"
```

---

### Task 6.2: Snippet Generation

**Files:**
- Create: `src/api/snippets.ts`
- Create: `tests/api/snippets.test.ts`

**Step 1: Write the failing test**

Create `tests/api/snippets.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { generateSnippet, highlightTerms } from '../../src/api/snippets';

describe('Snippets', () => {
  it('should extract around match', () => {
    const s = generateSnippet('before async after more text', 'async', 10);
    expect(s).toContain('async');
  });

  it('should highlight terms', () => {
    expect(highlightTerms('use async', ['async'])).toContain('**async**');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL

**Step 3: Implement**

Create `src/api/snippets.ts`:
```typescript
export function generateSnippet(content: string, query: string, ctx = 75): string {
  const terms = query.toLowerCase().split(/\s+/);
  const lower = content.toLowerCase();
  let idx = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i !== -1 && (idx === -1 || i < idx)) idx = i; }
  if (idx === -1) return content.slice(0, ctx * 2) + (content.length > ctx * 2 ? '...' : '');

  const start = Math.max(0, idx - ctx);
  const end = Math.min(content.length, idx + ctx);
  let s = content.slice(start, end);
  if (start > 0) s = '...' + s;
  if (end < content.length) s = s + '...';
  return s;
}

export function highlightTerms(text: string, terms: string[]): string {
  let r = text;
  for (const t of terms) r = r.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '**$1**');
  return r;
}
```

**Step 4: Run test**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): add snippet generation"
```

---

## Summary

**Phases covered:**
1. Test Infrastructure (vitest)
2. Database Schema (tables, FTS, triggers)
3. CRUD Operations (metadata, conversations, chunks)
4. Change Detection (hash, mtime, tombstones)
5. JSONL Parsing (user/assistant extraction)
6. Chunking (overlap, code-aware)
7. Search API (FTS with filters, snippets)

**Future phases (not in this plan):**
- sqlite-vec integration + vector search
- qwen3-embeddings-mlx sidecar
- RRF merge for hybrid ranking
- Background indexing worker
- UI components

---

**Plan saved.** Two execution options:

**1. Subagent-Driven (this session)** - Fresh subagent per task, review between tasks

**2. Parallel Session (separate)** - New session with executing-plans skill

Which approach?
