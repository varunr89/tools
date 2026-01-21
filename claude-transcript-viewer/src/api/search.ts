import { getDatabase } from '../db/index.js';
import { sanitizeFTSQuery } from '../db/chunks.js';
import {
  getRecentConversations,
  listConversations,
  Conversation,
} from '../db/conversations.js';

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

export function searchFTS(query: string, opts: SearchOptions): SearchResult[] {
  const db = getDatabase();
  const { project, role, after, before, limit = 20, offset = 0 } = opts;

  if (limit < 0 || offset < 0) return [];

  const sanitized = sanitizeFTSQuery(query);
  if (!sanitized) return [];

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
  const params: (string | number)[] = [sanitized];

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

export interface SearchWithFallbackResult {
  type: 'search' | 'recent';
  results?: SearchResult[];
  conversations?: Conversation[];
}

export function searchWithFallback(
  query: string,
  opts: SearchOptions
): SearchWithFallbackResult {
  const trimmed = query.trim();

  if (!trimmed) {
    const conversations = opts.project
      ? listConversations(opts.project)
      : getRecentConversations(opts.limit || 20);
    return { type: 'recent', conversations };
  }

  const results = searchFTS(query, opts);
  return { type: 'search', results };
}
