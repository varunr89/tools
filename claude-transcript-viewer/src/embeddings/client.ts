import * as http from 'http';
import * as net from 'net';

export interface EmbeddingResponse {
  embedding: number[];
  tokens: number;
}

export interface ModelInfo {
  model: string;
  dim: number;
}

export interface EmbeddingClient {
  isHealthy(): Promise<boolean>;
  embed(text: string): Promise<EmbeddingResponse | null>;
  embedBatch(texts: string[]): Promise<EmbeddingResponse[] | null>;
  getModelInfo(): Promise<ModelInfo | null>;
  close(): void;
}

interface RequestOptions {
  socketPath: string;
  path: string;
  method: string;
  body?: string;
  timeout?: number;
}

async function makeRequest(options: RequestOptions): Promise<{
  statusCode: number;
  body: string;
} | null> {
  return new Promise((resolve) => {
    const { socketPath, path, method, body, timeout = 5000 } = options;

    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }
          : {},
        timeout,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body: responseBody });
        });
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

class EmbeddingClientImpl implements EmbeddingClient {
  private socketPath: string;
  private timeout: number;

  constructor(socketPath: string, timeout = 5000) {
    this.socketPath = socketPath;
    this.timeout = timeout;
  }

  async isHealthy(): Promise<boolean> {
    const result = await makeRequest({
      socketPath: this.socketPath,
      path: '/health',
      method: 'GET',
      timeout: this.timeout,
    });

    return result !== null && result.statusCode === 200;
  }

  async embed(text: string): Promise<EmbeddingResponse | null> {
    const result = await makeRequest({
      socketPath: this.socketPath,
      path: '/embed',
      method: 'POST',
      body: JSON.stringify({ text }),
      timeout: this.timeout,
    });

    if (!result || result.statusCode !== 200) {
      return null;
    }

    try {
      const parsed = JSON.parse(result.body);
      return {
        embedding: parsed.embedding,
        tokens: parsed.tokens,
      };
    } catch {
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResponse[] | null> {
    if (texts.length === 0) {
      return [];
    }

    const result = await makeRequest({
      socketPath: this.socketPath,
      path: '/embed/batch',
      method: 'POST',
      body: JSON.stringify({ texts }),
      timeout: this.timeout,
    });

    if (!result || result.statusCode !== 200) {
      return null;
    }

    try {
      const parsed = JSON.parse(result.body);
      return parsed.embeddings.map((e: { embedding: number[]; tokens: number }) => ({
        embedding: e.embedding,
        tokens: e.tokens,
      }));
    } catch {
      return null;
    }
  }

  async getModelInfo(): Promise<ModelInfo | null> {
    const result = await makeRequest({
      socketPath: this.socketPath,
      path: '/health',
      method: 'GET',
      timeout: this.timeout,
    });

    if (!result || result.statusCode !== 200) {
      return null;
    }

    try {
      const parsed = JSON.parse(result.body);
      return {
        model: parsed.model,
        dim: parsed.dim,
      };
    } catch {
      return null;
    }
  }

  close(): void {
    // No persistent connections to close in this implementation
    // Future: could add connection pooling
  }
}

export function createEmbeddingClient(
  socketPath: string,
  timeout = 5000
): EmbeddingClient {
  return new EmbeddingClientImpl(socketPath, timeout);
}
