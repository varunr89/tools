import * as http from 'http';

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
  socketPath?: string;
  hostname?: string;
  port?: number;
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
    const { socketPath, hostname, port, path, method, body, timeout = 5000 } = options;

    const reqOptions: http.RequestOptions = {
      path,
      method,
      headers: body
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          }
        : {},
      timeout,
    };

    // Support both Unix socket and HTTP
    if (socketPath) {
      reqOptions.socketPath = socketPath;
    } else if (hostname && port) {
      reqOptions.hostname = hostname;
      reqOptions.port = port;
    }

    const req = http.request(reqOptions, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body: responseBody });
      });
    });

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
  private socketPath?: string;
  private hostname?: string;
  private port?: number;
  private timeout: number;
  private batchEndpoint: string;

  constructor(endpoint: string, timeout = 5000) {
    this.timeout = timeout;

    // Parse endpoint - could be Unix socket path or HTTP URL
    if (endpoint.startsWith('http://')) {
      const url = new URL(endpoint);
      this.hostname = url.hostname;
      this.port = parseInt(url.port) || 8000;
      // qwen3-embeddings-mlx uses /embed_batch, not /embed/batch
      this.batchEndpoint = '/embed_batch';
    } else {
      // Unix socket path
      this.socketPath = endpoint;
      this.batchEndpoint = '/embed/batch';
    }
  }

  private getRequestBase(): Pick<RequestOptions, 'socketPath' | 'hostname' | 'port'> {
    if (this.socketPath) {
      return { socketPath: this.socketPath };
    }
    return { hostname: this.hostname, port: this.port };
  }

  async isHealthy(): Promise<boolean> {
    const result = await makeRequest({
      ...this.getRequestBase(),
      path: '/health',
      method: 'GET',
      timeout: this.timeout,
    });

    return result !== null && result.statusCode === 200;
  }

  async embed(text: string): Promise<EmbeddingResponse | null> {
    const result = await makeRequest({
      ...this.getRequestBase(),
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
        tokens: parsed.tokens || parsed.tokens_processed || 0,
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
      ...this.getRequestBase(),
      path: this.batchEndpoint,
      method: 'POST',
      body: JSON.stringify({ texts }),
      timeout: this.timeout,
    });

    if (!result || result.statusCode !== 200) {
      return null;
    }

    try {
      const parsed = JSON.parse(result.body);
      return parsed.embeddings.map((e: { embedding: number[]; tokens?: number; tokens_processed?: number }) => ({
        embedding: e.embedding,
        tokens: e.tokens || e.tokens_processed || 0,
      }));
    } catch {
      return null;
    }
  }

  async getModelInfo(): Promise<ModelInfo | null> {
    const result = await makeRequest({
      ...this.getRequestBase(),
      path: '/health',
      method: 'GET',
      timeout: this.timeout,
    });

    if (!result || result.statusCode !== 200) {
      return null;
    }

    try {
      const parsed = JSON.parse(result.body);
      // qwen3-embeddings-mlx uses model_name and embedding_dim
      return {
        model: parsed.model || parsed.model_name || parsed.default_model || 'unknown',
        dim: parsed.dim || parsed.embedding_dim || parsed.dimensions || 0,
      };
    } catch {
      return null;
    }
  }

  close(): void {
    // No persistent connections to close in this implementation
  }
}

export function createEmbeddingClient(
  endpoint: string,
  timeout = 5000
): EmbeddingClient {
  return new EmbeddingClientImpl(endpoint, timeout);
}
