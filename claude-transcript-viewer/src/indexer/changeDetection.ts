import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getDatabase } from '../db/index.js';
import { getFileHash, getFileMtime } from './fileUtils.js';

export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
}

interface IndexedRecord {
  id: string;
  file_path: string;
  content_hash: string;
  source_mtime: number;
}

/**
 * Detect changes between the file system and the indexed database.
 *
 * Uses a two-phase check:
 * 1. Quick mtime comparison to skip unchanged files
 * 2. Hash comparison only when mtime differs
 *
 * @param sourceDir - Directory to scan for .jsonl files
 * @returns ChangeSet with added, modified, and deleted file paths/ids
 */
export function detectChanges(sourceDir: string): ChangeSet {
  const db = getDatabase();
  const changes: ChangeSet = { added: [], modified: [], deleted: [] };

  // Find all .jsonl files in the source directory (recursively)
  const files = findJsonlFiles(sourceDir);
  const fileSet = new Set(files);

  // Get all indexed conversations from the database
  const indexed = db
    .prepare(
      'SELECT id, file_path, content_hash, source_mtime FROM conversations'
    )
    .all() as IndexedRecord[];

  // Build a map of file_path -> record for quick lookup
  const indexedPaths = new Map<
    string,
    { id: string; hash: string; mtime: number }
  >(
    indexed.map((r) => [
      r.file_path,
      { id: r.id, hash: r.content_hash, mtime: r.source_mtime },
    ])
  );

  // Check each file on disk
  for (const filePath of files) {
    const existing = indexedPaths.get(filePath);

    if (!existing) {
      // File is not in database - it's new
      changes.added.push(filePath);
    } else {
      // File exists in database - check if modified
      const currentMtime = getFileMtime(filePath);

      // Quick check: if mtime matches, assume unchanged
      if (currentMtime !== existing.mtime) {
        // Mtime differs - need to check hash
        const currentHash = getFileHash(filePath);
        if (currentHash !== existing.hash) {
          changes.modified.push(filePath);
        }
      }
    }
  }

  // Check for deleted files (in database but not on disk)
  for (const [filePath, info] of indexedPaths) {
    if (!fileSet.has(filePath) && !existsSync(filePath)) {
      changes.deleted.push(info.id);
    }
  }

  return changes;
}

/**
 * Recursively find all .jsonl files in a directory.
 *
 * @param dir - Directory to scan
 * @returns Array of absolute file paths
 */
function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];

  function scan(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  scan(dir);
  return files;
}
