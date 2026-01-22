import { getDatabase } from '../db/index.js';
import { sanitizeFTSQuery } from '../db/chunks.js';
import {
  getRecentConversations,
  listConversations,
  Conversation,
} from '../db/conversations.js';
import { EmbeddingClient } from '../embeddings/client.js';

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

export function searchVector(
  queryEmbedding: Buffer,
  opts: SearchOptions
): SearchResult[] {
  const db = getDatabase();
  const { project, role, after, before, limit = 100, offset = 0 } = opts;

  if (limit < 0 || offset < 0) return [];

  let sql = `
    SELECT
      c.id as chunk_id,
      c.conversation_id,
      conv.title,
      conv.project,
      c.role,
      c.content,
      c.page_number,
      vec_distance_cosine(cv.embedding, ?) as score
    FROM chunks c
    JOIN chunks_vec cv ON cv.rowid = c.id
    JOIN conversations conv ON conv.id = c.conversation_id
    WHERE 1=1
  `;
  const params: (Buffer | string | number)[] = [queryEmbedding];

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

  sql += ' ORDER BY score ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params) as SearchResult[];
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

export interface RRFOptions {
  limit?: number;
  k?: number;
}

/**
 * Merge results from vector and FTS search using Reciprocal Rank Fusion.
 * RRF combines rankings by computing: score(doc) = Σ 1/(k + rank)
 * Documents appearing in both result sets get boosted scores.
 */
export function mergeResultsRRF(
  vectorResults: SearchResult[],
  ftsResults: SearchResult[],
  options: RRFOptions = {}
): SearchResult[] {
  const { limit = 20, k = 60 } = options;

  // Map chunk_id to combined RRF score and first-seen result data
  const scores = new Map<number, number>();
  const resultData = new Map<number, SearchResult>();

  // Process vector results
  vectorResults.forEach((result, rank) => {
    const rrfScore = 1 / (k + rank);
    scores.set(result.chunk_id, (scores.get(result.chunk_id) || 0) + rrfScore);
    if (!resultData.has(result.chunk_id)) {
      resultData.set(result.chunk_id, result);
    }
  });

  // Process FTS results
  ftsResults.forEach((result, rank) => {
    const rrfScore = 1 / (k + rank);
    scores.set(result.chunk_id, (scores.get(result.chunk_id) || 0) + rrfScore);
    if (!resultData.has(result.chunk_id)) {
      resultData.set(result.chunk_id, result);
    }
  });

  // Sort by combined score (descending) and limit
  const sortedIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  // Build final results with updated scores
  return sortedIds.map((id) => ({
    ...resultData.get(id)!,
    score: scores.get(id)!,
  }));
}

export interface HybridSearchResult {
  type: 'hybrid' | 'fts_only' | 'recent';
  results?: SearchResult[];
  conversations?: Conversation[];
  embeddingStatus?: 'available' | 'unavailable';
}

/**
 * Perform hybrid search combining vector and FTS results with RRF.
 * Falls back to FTS-only when embeddings unavailable.
 * Returns recent conversations for empty queries.
 */
export async function searchHybrid(
  query: string,
  opts: SearchOptions,
  embeddingClient?: EmbeddingClient
): Promise<HybridSearchResult> {
  const trimmed = query.trim();

  // Empty query: return recent conversations
  if (!trimmed) {
    const conversations = opts.project
      ? listConversations(opts.project)
      : getRecentConversations(opts.limit || 20);
    return { type: 'recent', conversations };
  }

  // Try to get embedding for the query
  let queryEmbedding: Buffer | null = null;
  if (embeddingClient) {
    const embeddingResult = await embeddingClient.embed(trimmed);
    if (embeddingResult) {
      // Convert number[] to Float32Array buffer
      queryEmbedding = Buffer.from(
        new Float32Array(embeddingResult.embedding).buffer
      );
    }
  }

  // Always get FTS results
  const ftsResults = searchFTS(query, { ...opts, limit: 100 });

  // If we have embeddings, do hybrid search
  if (queryEmbedding) {
    const vectorResults = searchVector(queryEmbedding, { ...opts, limit: 100 });
    const merged = mergeResultsRRF(vectorResults, ftsResults, {
      limit: opts.limit || 20,
    });
    return {
      type: 'hybrid',
      results: merged,
      embeddingStatus: 'available',
    };
  }

  // Fallback to FTS-only
  return {
    type: 'fts_only',
    results: ftsResults.slice(0, opts.limit || 20),
    embeddingStatus: 'unavailable',
  };
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
