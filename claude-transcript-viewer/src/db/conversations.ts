import { getDatabase } from './index.js';

export interface Conversation {
  id: string;
  project: string;
  title: string | null;
  created_at: string | null;
  file_path: string;
  content_hash: string;
  source_mtime: number;
  indexed_at?: string;
}

export function insertConversation(c: Conversation): void {
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO conversations
       (id, project, title, created_at, file_path, content_hash, source_mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(c.id, c.project, c.title, c.created_at, c.file_path, c.content_hash, c.source_mtime);
}

export function getConversation(id: string): Conversation | null {
  const result = getDatabase()
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(id) as Conversation | undefined;
  return result ?? null;
}

export function getConversationByPath(path: string): Conversation | null {
  const result = getDatabase()
    .prepare('SELECT * FROM conversations WHERE file_path = ?')
    .get(path) as Conversation | undefined;
  return result ?? null;
}

export function deleteConversation(id: string): void {
  getDatabase().prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

export function listConversations(project?: string): Conversation[] {
  const db = getDatabase();
  if (project) {
    return db
      .prepare('SELECT * FROM conversations WHERE project = ? ORDER BY created_at DESC')
      .all(project) as Conversation[];
  }
  return db
    .prepare('SELECT * FROM conversations ORDER BY created_at DESC')
    .all() as Conversation[];
}

export function getRecentConversations(limit: number = 10): Conversation[] {
  return getDatabase()
    .prepare('SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Conversation[];
}
