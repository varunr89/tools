import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, getMetadata, setMetadata } from '../../src/db';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), 'test-metadata.db');

describe('Metadata Operations', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should set and get metadata', () => {
    setMetadata('model_id', 'qwen3-medium');
    expect(getMetadata('model_id')).toBe('qwen3-medium');
  });

  it('should return null for missing key', () => {
    expect(getMetadata('nonexistent')).toBeNull();
  });

  it('should update existing metadata', () => {
    setMetadata('model_id', 'qwen3-small');
    setMetadata('model_id', 'qwen3-large');
    expect(getMetadata('model_id')).toBe('qwen3-large');
  });

  it('should have schema_version set on creation', () => {
    expect(getMetadata('schema_version')).toBe('1');
  });

  it('should track embedding model and dimension for reindex detection', () => {
    setMetadata('embedding_model', 'qwen3-medium');
    setMetadata('embedding_dim', '2048');
    expect(getMetadata('embedding_model')).toBe('qwen3-medium');
    expect(getMetadata('embedding_dim')).toBe('2048');
  });
});
