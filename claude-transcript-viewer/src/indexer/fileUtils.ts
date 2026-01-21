import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';

export function getFileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function getFileMtime(path: string): number {
  return Math.floor(statSync(path).mtimeMs / 1000);
}
