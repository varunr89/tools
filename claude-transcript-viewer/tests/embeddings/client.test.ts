import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EmbeddingClient,
  createEmbeddingClient,
  EmbeddingResponse,
} from '../../src/embeddings/client.js';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

describe('EmbeddingClient', () => {
  let server: net.Server;
  let socketPath: string;
  let client: EmbeddingClient;

  beforeEach(() => {
    socketPath = path.join(os.tmpdir(), `test-embed-${Date.now()}.sock`);
    // Clean up any existing socket
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  });

  afterEach(async () => {
    if (client) {
      client.close();
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  });

  function createMockServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<void> {
    return new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(socketPath, () => resolve());
    });
  }

  describe('health check', () => {
    it('returns true when server responds to health endpoint', async () => {
      await createMockServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', model: 'qwen3-medium' }));
        }
      });

      client = createEmbeddingClient(socketPath);
      const healthy = await client.isHealthy();
      expect(healthy).toBe(true);
    });

    it('returns false when server is unavailable', async () => {
      // Don't start server - socket doesn't exist
      client = createEmbeddingClient('/nonexistent/socket.sock');
      const healthy = await client.isHealthy();
      expect(healthy).toBe(false);
    });

    it('returns false when server returns non-200', async () => {
      await createMockServer((req, res) => {
        res.writeHead(500);
        res.end('Internal error');
      });

      client = createEmbeddingClient(socketPath);
      const healthy = await client.isHealthy();
      expect(healthy).toBe(false);
    });
  });

  describe('embed single text', () => {
    it('returns embedding vector for text', async () => {
      const mockEmbedding = Array(2048).fill(0.1);
      await createMockServer((req, res) => {
        if (req.url === '/embed' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            const { text } = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                embedding: mockEmbedding,
                tokens: text.split(' ').length,
              })
            );
          });
        }
      });

      client = createEmbeddingClient(socketPath);
      const result = await client.embed('hello world');
      expect(result).not.toBeNull();
      expect(result!.embedding).toHaveLength(2048);
      expect(result!.tokens).toBe(2);
    });

    it('returns null when server unavailable', async () => {
      client = createEmbeddingClient('/nonexistent/socket.sock');
      const result = await client.embed('test');
      expect(result).toBeNull();
    });
  });

  describe('batch embed', () => {
    it('returns embeddings for multiple texts', async () => {
      const mockEmbedding = Array(2048).fill(0.1);
      await createMockServer((req, res) => {
        if (req.url === '/embed/batch' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            const { texts } = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                embeddings: texts.map((t: string) => ({
                  embedding: mockEmbedding,
                  tokens: t.split(' ').length,
                })),
              })
            );
          });
        }
      });

      client = createEmbeddingClient(socketPath);
      const results = await client.embedBatch(['hello', 'world test', 'foo']);
      expect(results).toHaveLength(3);
      expect(results![0].embedding).toHaveLength(2048);
      expect(results![1].tokens).toBe(2);
    });

    it('returns null when server unavailable', async () => {
      client = createEmbeddingClient('/nonexistent/socket.sock');
      const results = await client.embedBatch(['test1', 'test2']);
      expect(results).toBeNull();
    });

    it('returns empty array for empty input', async () => {
      await createMockServer((req, res) => {
        // Should not be called
        res.writeHead(200);
        res.end(JSON.stringify({ embeddings: [] }));
      });

      client = createEmbeddingClient(socketPath);
      const results = await client.embedBatch([]);
      expect(results).toEqual([]);
    });
  });

  describe('model info', () => {
    it('returns model info from health check', async () => {
      await createMockServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              model: 'qwen3-medium',
              dim: 2048,
            })
          );
        }
      });

      client = createEmbeddingClient(socketPath);
      const info = await client.getModelInfo();
      expect(info).toEqual({
        model: 'qwen3-medium',
        dim: 2048,
      });
    });

    it('returns null when server unavailable', async () => {
      client = createEmbeddingClient('/nonexistent/socket.sock');
      const info = await client.getModelInfo();
      expect(info).toBeNull();
    });
  });
});
