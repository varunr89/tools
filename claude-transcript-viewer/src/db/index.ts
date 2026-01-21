import Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION, FTS_TABLE_SQL, TRIGGER_SQL } from './schema.js';

let db: Database.Database | null = null;

export function createDatabase(dbPath: string): Database.Database {
  if (db) {
    db.close();
  }
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
