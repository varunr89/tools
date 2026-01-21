import { beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'fs';

// Clean up test databases before each test
beforeEach(() => {
  const testDb = '/tmp/test-search.db';
  if (existsSync(testDb)) {
    unlinkSync(testDb);
  }
});
