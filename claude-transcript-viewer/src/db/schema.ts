export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
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

// Vector table for semantic search (2048 dimensions for qwen3-medium model)
export const VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  embedding float[2048]
);
`;

export const TRIGGER_SQL = `
-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (NEW.id, NEW.content);
  INSERT INTO chunks_vec(rowid, embedding) SELECT NEW.id, NEW.embedding WHERE NEW.embedding IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', OLD.id, OLD.content);
  DELETE FROM chunks_vec WHERE rowid = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', OLD.id, OLD.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (NEW.id, NEW.content);
  DELETE FROM chunks_vec WHERE rowid = OLD.id;
  INSERT INTO chunks_vec(rowid, embedding) SELECT NEW.id, NEW.embedding WHERE NEW.embedding IS NOT NULL;
END;
`;
