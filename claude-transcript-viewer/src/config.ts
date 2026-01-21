import { existsSync } from 'fs';

export interface Config {
  ARCHIVE_DIR: string;
  SOURCE_DIR: string;
  DATABASE_PATH: string;
  EMBED_SOCKET: string;
  AUTO_UPDATE: boolean;
  PYTHON_CMD: string;
  CHUNK_SIZE: number;
  CHUNK_OVERLAP: number;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIM: number;
}

const defaults: Config = {
  ARCHIVE_DIR: './archive',
  SOURCE_DIR: './source',
  DATABASE_PATH: './search.db',
  EMBED_SOCKET: '/tmp/qwen3-embed.sock',
  AUTO_UPDATE: true,
  PYTHON_CMD: 'python3',
  CHUNK_SIZE: 300,
  CHUNK_OVERLAP: 50,
  EMBEDDING_MODEL: 'qwen3-medium',
  EMBEDDING_DIM: 2048,
};

export function getConfig(): Config {
  return {
    ARCHIVE_DIR: process.env.ARCHIVE_DIR || defaults.ARCHIVE_DIR,
    SOURCE_DIR: process.env.SOURCE_DIR || defaults.SOURCE_DIR,
    DATABASE_PATH: process.env.DATABASE_PATH || defaults.DATABASE_PATH,
    EMBED_SOCKET: process.env.EMBED_SOCKET || defaults.EMBED_SOCKET,
    AUTO_UPDATE: process.env.AUTO_UPDATE !== 'false',
    PYTHON_CMD: process.env.PYTHON_CMD || defaults.PYTHON_CMD,
    CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE || String(defaults.CHUNK_SIZE), 10),
    CHUNK_OVERLAP: parseInt(process.env.CHUNK_OVERLAP || String(defaults.CHUNK_OVERLAP), 10),
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || defaults.EMBEDDING_MODEL,
    EMBEDDING_DIM: parseInt(process.env.EMBEDDING_DIM || String(defaults.EMBEDDING_DIM), 10),
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  if (!existsSync(config.ARCHIVE_DIR)) {
    errors.push(`ARCHIVE_DIR does not exist: ${config.ARCHIVE_DIR}`);
  }
  if (!existsSync(config.SOURCE_DIR)) {
    errors.push(`SOURCE_DIR does not exist: ${config.SOURCE_DIR}`);
  }
  if (config.CHUNK_SIZE < 100 || config.CHUNK_SIZE > 1000) {
    errors.push(`CHUNK_SIZE must be between 100 and 1000: ${config.CHUNK_SIZE}`);
  }
  if (config.CHUNK_OVERLAP < 0 || config.CHUNK_OVERLAP >= config.CHUNK_SIZE) {
    errors.push(`CHUNK_OVERLAP must be between 0 and CHUNK_SIZE: ${config.CHUNK_OVERLAP}`);
  }

  return errors;
}
