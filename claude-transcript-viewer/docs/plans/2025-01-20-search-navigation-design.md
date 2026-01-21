# Search, Navigation & Filtering Design

**Date:** 2025-01-20
**Status:** Reviewed by Codex
**Last Updated:** 2025-01-20 (incorporated Codex feedback)

## Overview

Add semantic search, project navigation, and filtering to the Claude Transcript Viewer. Uses RAG-based search with local embeddings on Apple Silicon.

## Architecture

```
┌─────────────────────┐  Unix Socket  ┌──────────────────────┐
│  TypeScript Server  │ ────────────► │  qwen3-embeddings    │
│  (Express)          │   /embed      │  (MLX REST API)      │
└─────────────────────┘               └──────────────────────┘
         │
         ▼
┌─────────────────────┐
│  SQLite + sqlite-vec│
│  (WAL mode)         │
└─────────────────────┘
```

**Key decisions:**
- Sidecar embedding server (not in-process) - MLX requires Python
- Local Unix socket for lower latency than HTTP
- Health checks + graceful fallback when embeddings unavailable
- Batch embedding requests for efficiency

## Data Source

**Index raw JSONL transcripts, not HTML.**

Reasons:
- Avoids embedding HTML markup noise
- Preserves structured metadata (timestamps, roles, tool calls)
- More reliable parsing than scraping generated HTML

Tool call outputs are **excluded** from search index (too noisy, mostly code/JSON).

## Background Indexing Workflow

**Critical: Never block server startup on indexing.**

```
Server Start
  │
  ├─► Check for existing index
  │     └─► If valid: serve immediately
  │
  ├─► Spawn background worker (separate process)
  │     ├─► Acquire lock file (.indexing.lock)
  │     ├─► Run claude-code-transcripts all (if AUTO_UPDATE=true)
  │     ├─► Detect changes via content_hash comparison
  │     ├─► Index new/modified conversations
  │     ├─► Purge tombstones for deleted files
  │     ├─► Atomic swap: new index → live
  │     └─► Release lock
  │
  └─► Serve queries against "last-known-good" index during rebuild
```

**Failure handling:**
- If indexing crashes, lock file has PID - detect stale locks
- If embedding server unavailable, log warning and skip vector indexing
- Partial index is never served - atomic swap only on success

## Embedding Backend

Using [qwen3-embeddings-mlx](https://github.com/jakedahn/qwen3-embeddings-mlx) for Apple Silicon GPU acceleration.

| Model | Speed | Quality | Memory | Dimensions |
|-------|-------|---------|--------|------------|
| Small (0.6B) | 44K tokens/sec | ⭐⭐ | 900MB | 1024 |
| Medium (4B) | 18K tokens/sec | ⭐⭐⭐ | 2.5GB | 2048 |
| Large (8B) | 11K tokens/sec | ⭐⭐⭐⭐ | 4.5GB | 4096 |

Default: Medium model

**Model versioning:** Store `model_id` and `embedding_dim` in metadata table. Force full reindex when model changes.

## Database Schema

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- Metadata for schema versioning and model tracking
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Store: schema_version, model_id, embedding_dim, last_full_index

-- Conversations table
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT,
  created_at DATETIME,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,      -- SHA256 of source file
  source_mtime INTEGER NOT NULL,   -- Source file mtime for quick checks
  indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_conversations_project ON conversations(project);
CREATE INDEX idx_conversations_created ON conversations(created_at);

-- Chunks table (for semantic search)
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,    -- Position within conversation
  page_number INTEGER,
  role TEXT NOT NULL,              -- 'user' or 'assistant'
  content TEXT NOT NULL,
  embedding BLOB,                  -- Vector from embedding model
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_chunks_conversation ON chunks(conversation_id);
CREATE INDEX idx_chunks_role ON chunks(role);

-- Vector index for similarity search (linked by rowid)
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  embedding float[2048]            -- Must match model embedding_dim
);

-- FTS5 for keyword search with code-friendly tokenizer
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='trigram'               -- Better for code search
);

-- Sync triggers to keep chunks_vec and chunks_fts in sync
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_vec(rowid, embedding) VALUES (NEW.id, NEW.embedding);
  INSERT INTO chunks_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_vec WHERE rowid = OLD.id;
  DELETE FROM chunks_fts WHERE rowid = OLD.id;
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  UPDATE chunks_vec SET embedding = NEW.embedding WHERE rowid = NEW.id;
  DELETE FROM chunks_fts WHERE rowid = OLD.id;
  INSERT INTO chunks_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;
```

## Chunking Strategy

**Target: 200-400 tokens with 50-token overlap**

```
Message 1 (800 tokens)
  ├─► Chunk 1: tokens 0-300
  ├─► Chunk 2: tokens 250-550 (50 overlap)
  └─► Chunk 3: tokens 500-800 (50 overlap)
```

**Special handling:**
- Code blocks: Keep intact if <400 tokens, split at line boundaries otherwise
- Long lines: Force split at 400 tokens regardless of boundaries
- Paragraph boundaries: Preferred split points when available

**Metadata per chunk:**
- `chunk_index`: Position for ordering
- `page_number`: For linking to HTML view
- `role`: user/assistant for filtering

## Change Detection

**Three-tier detection:**

1. **Quick check:** `source_mtime` - skip unchanged files
2. **Content check:** `content_hash` (SHA256) - detect actual changes
3. **Tombstone:** Files in index but not on disk - mark for deletion

```typescript
interface ChangeSet {
  added: string[];      // New files
  modified: string[];   // Hash changed
  deleted: string[];    // File removed
}
```

## Search API

### Endpoint

```
GET /api/search?q=<query>&project=<optional>&role=<optional>&after=<date>&before=<date>&limit=20&offset=0
```

### Hybrid Search with Integrated Filters

**Critical: Apply filters INSIDE queries, not after.**

```sql
-- Vector search with filters (pseudo-SQL)
SELECT c.id, c.content, c.conversation_id,
       vec_distance_cosine(cv.embedding, :query_embedding) as distance
FROM chunks c
JOIN chunks_vec cv ON cv.rowid = c.id
JOIN conversations conv ON conv.id = c.conversation_id
WHERE (:project IS NULL OR conv.project = :project)
  AND (:role IS NULL OR c.role = :role)
  AND (:after IS NULL OR conv.created_at >= :after)
  AND (:before IS NULL OR conv.created_at <= :before)
ORDER BY distance ASC
LIMIT 100;  -- Overfetch for RRF merge

-- FTS search with filters
SELECT c.id, c.content, c.conversation_id,
       bm25(chunks_fts) as score
FROM chunks_fts fts
JOIN chunks c ON c.id = fts.rowid
JOIN conversations conv ON conv.id = c.conversation_id
WHERE chunks_fts MATCH :sanitized_query
  AND (:project IS NULL OR conv.project = :project)
  AND (:role IS NULL OR c.role = :role)
  AND (:after IS NULL OR conv.created_at >= :after)
  AND (:before IS NULL OR conv.created_at <= :before)
ORDER BY score
LIMIT 100;
```

**Query sanitization:** Escape FTS5 special characters (`"`, `*`, `OR`, `AND`, `NOT`, `(`, `)`)

### Reciprocal Rank Fusion

```typescript
function mergeResults(vectorResults: Result[], ftsResults: Result[], k = 60): Result[] {
  const scores = new Map<number, number>();

  vectorResults.forEach((r, rank) => {
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + rank));
  });

  ftsResults.forEach((r, rank) => {
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + rank));
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));
}
```

### Response Format

```json
{
  "results": [
    {
      "chunk_id": 123,
      "conversation_id": "abc123",
      "project": "courses",
      "title": "Help me understand async/await",
      "snippet": "...the key insight is that **await** pauses execution...",
      "role": "assistant",
      "page": 1,
      "score": 0.89,
      "url": "/courses/abc123/page-001.html#chunk-123"
    }
  ],
  "total": 42,
  "query_time_ms": 45,
  "index_status": "current"  // or "rebuilding"
}
```

### Fallback Modes

| Condition | Behavior |
|-----------|----------|
| Embedding server down | FTS-only search (warn in response) |
| Index rebuilding | Query stale index (note in response) |
| Empty query | Return recent conversations |
| No results | Suggest broader search terms |

## UI Components

### Search Bar (injected into every page)

```html
<div class="search-container">
  <input type="search" id="global-search" placeholder="Search conversations..." />
  <div id="search-results" class="search-dropdown hidden"></div>
  <div id="search-status" class="search-status"></div>  <!-- Shows "rebuilding" status -->
</div>
```

### Search Results Dropdown

Shows top 5 results as you type with:
- Conversation title
- Snippet with highlighted terms
- Project name and date
- "View all N results" link

### Landing Page (/)

- Project cards with session count and last updated
- Recent conversations list
- Global search bar
- Index status indicator

### Full Search Results Page (/search)

- Filter sidebar (project, date range, role)
- Results list with full snippets
- Pagination with offset/limit
- Conversation-level deduplication option

## Configuration

```typescript
interface Config {
  ARCHIVE_DIR: string;           // Where HTML files live
  SOURCE_DIR: string;            // Where JSONL files live
  DATABASE_PATH: string;         // SQLite database location
  EMBED_SOCKET: string;          // Unix socket for embedding server
  AUTO_UPDATE: boolean;          // Run regeneration on start (default: true)
  PYTHON_CMD: string;            // Python executable (default: python3)
  CHUNK_SIZE: number;            // Target tokens per chunk (default: 300)
  CHUNK_OVERLAP: number;         // Overlap tokens (default: 50)
  EMBEDDING_MODEL: string;       // Model name for metadata tracking
  EMBEDDING_DIM: number;         // Vector dimensions (must match model)
}
```

## Implementation Phases

### Phase 1: Database & Core Infrastructure
1. Set up SQLite + sqlite-vec with triggers
2. Create metadata table and versioning
3. Implement change detection logic
4. Add background worker with lock file

### Phase 2: Embedding Integration
5. Add qwen3-embeddings-mlx as dependency
6. Create embedding client with health checks
7. Implement batched embedding requests
8. Add fallback mode for embedding failures

### Phase 3: Indexing Pipeline
9. Create JSONL parser for message extraction
10. Build chunker with overlap and code handling
11. Implement incremental indexer
12. Add tombstone/purge for deleted files

### Phase 4: Search API
13. Implement hybrid search with integrated filters
14. Add query sanitization for FTS
15. Implement RRF merge
16. Add snippet generation with highlighting

### Phase 5: UI Components
17. Create landing page
18. Add search bar component
19. Build search dropdown
20. Create full results page with filters

### Phase 6: Integration & Polish
21. Wire up background indexing on start
22. Add index status indicators
23. Implement graceful degradation
24. End-to-end testing

## Dependencies

**Python:**
- qwen3-embeddings-mlx
- claude-code-transcripts

**Node.js:**
- better-sqlite3
- sqlite-vec (native addon)
- cheerio (existing)

## Testing Strategy

- Unit tests for chunking logic
- Unit tests for change detection
- Integration tests for sync triggers
- Integration tests for hybrid search ranking
- E2E tests for background indexing
- Benchmark tests for query latency at scale

## Open Items

- [ ] Benchmark query latency at 100k chunks
- [ ] Evaluate if trigram tokenizer is sufficient or need custom
- [ ] Determine acceptable staleness window during rebuild
- [ ] Design conversation-level deduplication in results
