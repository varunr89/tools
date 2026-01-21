import { getDatabase } from './index.js';

export interface Chunk {
  id?: number;
  conversation_id: string;
  chunk_index: number;
  page_number: number | null;
  role: 'user' | 'assistant';
  content: string;
  embedding: Buffer | null;
}

export function insertChunk(c: Chunk): number {
  const result = getDatabase()
    .prepare(
      `INSERT INTO chunks
       (conversation_id, chunk_index, page_number, role, content, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(c.conversation_id, c.chunk_index, c.page_number, c.role, c.content, c.embedding);
  return result.lastInsertRowid as number;
}

export function getChunksForConversation(conversationId: string): Chunk[] {
  return getDatabase()
    .prepare('SELECT * FROM chunks WHERE conversation_id = ? ORDER BY chunk_index')
    .all(conversationId) as Chunk[];
}

export function searchChunksFTS(query: string, limit = 100): Chunk[] {
  const sanitized = sanitizeFTSQuery(query);
  if (!sanitized) return [];

  return getDatabase()
    .prepare(
      `SELECT c.* FROM chunks_fts fts
       JOIN chunks c ON c.id = fts.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY bm25(chunks_fts)
       LIMIT ?`
    )
    .all(sanitized, limit) as Chunk[];
}

export function sanitizeFTSQuery(query: string): string {
  // Remove FTS5 special characters and operators
  return query
    .replace(/["\*\(\)]/g, ' ')           // Remove quotes, wildcards, parentheses
    .replace(/\b(AND|OR|NOT)\b/gi, ' ')   // Remove boolean operators
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token}"`)          // Wrap each token in quotes for exact matching
    .join(' ');
}

export function deleteChunksForConversation(conversationId: string): void {
  getDatabase()
    .prepare('DELETE FROM chunks WHERE conversation_id = ?')
    .run(conversationId);
}
