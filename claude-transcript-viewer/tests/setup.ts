import { beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testDb = join(tmpdir(), 'test-search.db');

beforeEach(() => {
  if (existsSync(testDb)) {
    unlinkSync(testDb);
  }
});

afterEach(() => {
  if (existsSync(testDb)) {
    unlinkSync(testDb);
  }
});
