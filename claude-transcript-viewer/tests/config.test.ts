import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, validateConfig, Config } from '../src/config';

describe('Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load default configuration', () => {
    const config = getConfig();
    expect(config.CHUNK_SIZE).toBe(300);
    expect(config.CHUNK_OVERLAP).toBe(50);
    expect(config.EMBEDDING_DIM).toBe(1024);
  });

  it('should load configuration from environment', () => {
    process.env.ARCHIVE_DIR = '/custom/archive';
    process.env.SOURCE_DIR = '/custom/source';
    process.env.DATABASE_PATH = '/custom/db.sqlite';
    process.env.EMBED_SOCKET = '/custom/embed.sock';

    const config = getConfig();
    expect(config.ARCHIVE_DIR).toBe('/custom/archive');
    expect(config.SOURCE_DIR).toBe('/custom/source');
    expect(config.DATABASE_PATH).toBe('/custom/db.sqlite');
    expect(config.EMBED_SOCKET).toBe('/custom/embed.sock');
  });

  it('should load AUTO_UPDATE from environment', () => {
    process.env.AUTO_UPDATE = 'false';
    const config = getConfig();
    expect(config.AUTO_UPDATE).toBe(false);
  });

  it('should validate required paths exist', () => {
    const config: Config = {
      ARCHIVE_DIR: '/nonexistent/path',
      SOURCE_DIR: '/nonexistent/source',
      DATABASE_PATH: '/tmp/test.db',
      EMBED_SOCKET: '/tmp/embed.sock',
      AUTO_UPDATE: true,
      PYTHON_CMD: 'python3',
      CHUNK_SIZE: 300,
      CHUNK_OVERLAP: 50,
      EMBEDDING_MODEL: 'qwen3-medium',
      EMBEDDING_DIM: 1024,
    };

    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('ARCHIVE_DIR'))).toBe(true);
  });

  it('should accept valid configuration', () => {
    const config: Config = {
      ARCHIVE_DIR: '/tmp',
      SOURCE_DIR: '/tmp',
      DATABASE_PATH: '/tmp/test.db',
      EMBED_SOCKET: '/tmp/embed.sock',
      AUTO_UPDATE: true,
      PYTHON_CMD: 'python3',
      CHUNK_SIZE: 300,
      CHUNK_OVERLAP: 50,
      EMBEDDING_MODEL: 'qwen3-medium',
      EMBEDDING_DIM: 1024,
    };

    const errors = validateConfig(config);
    expect(errors).toHaveLength(0);
  });
});
