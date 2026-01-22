/**
 * E2E test for hybrid search flow.
 * Tests the full pipeline: database -> indexing -> search -> results
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase, closeDatabase, getDatabase } from '../../src/db/index.js';
import { searchHybrid, searchFTS, searchVector } from '../../src/api/search.js';
import { generateSnippet, highlightTerms } from '../../src/api/snippets.js';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), 'e2e-hybrid-search.db');

describe('E2E: Hybrid Search Pipeline', () => {
  beforeAll(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    createDatabase(TEST_DB);
    seedTestData();
  });

  afterAll(() => {
    closeDatabase();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  function createEmbedding(seed: number): Buffer {
    const embedding = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      embedding[i] = Math.sin(seed + i * 0.1);
    }
    return Buffer.from(embedding.buffer);
  }

  function seedTestData() {
    const db = getDatabase();

    // Create projects and conversations
    const conversations = [
      {
        id: 'conv-react-hooks',
        project: 'web-dev',
        title: 'Understanding React Hooks',
        created_at: '2024-01-15',
      },
      {
        id: 'conv-python-async',
        project: 'backend',
        title: 'Python async/await patterns',
        created_at: '2024-02-20',
      },
      {
        id: 'conv-typescript-types',
        project: 'web-dev',
        title: 'Advanced TypeScript generics',
        created_at: '2024-03-10',
      },
    ];

    for (const conv of conversations) {
      db.prepare(
        `INSERT INTO conversations (id, project, title, file_path, content_hash, source_mtime, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        conv.id,
        conv.project,
        conv.title,
        `/transcripts/${conv.id}.jsonl`,
        `hash-${conv.id}`,
        Date.now(),
        conv.created_at
      );
    }

    // Create chunks with embeddings
    const chunks = [
      // React hooks conversation
      {
        conv: 'conv-react-hooks',
        role: 'user',
        content: 'How do I use useState and useEffect together?',
        seed: 1,
      },
      {
        conv: 'conv-react-hooks',
        role: 'assistant',
        content:
          'useState manages local state while useEffect handles side effects. You can combine them like this: const [data, setData] = useState(null); useEffect(() => { fetchData().then(setData); }, []);',
        seed: 2,
      },
      // Python async conversation
      {
        conv: 'conv-python-async',
        role: 'user',
        content: 'Explain async/await in Python',
        seed: 10,
      },
      {
        conv: 'conv-python-async',
        role: 'assistant',
        content:
          'Python async/await enables concurrent code execution. Use async def to define coroutines and await to pause execution until the awaited operation completes. asyncio.run() starts the event loop.',
        seed: 11,
      },
      // TypeScript conversation
      {
        conv: 'conv-typescript-types',
        role: 'user',
        content: 'How do TypeScript generics work with constraints?',
        seed: 20,
      },
      {
        conv: 'conv-typescript-types',
        role: 'assistant',
        content:
          'TypeScript generics with constraints use extends keyword: function process<T extends { id: number }>(item: T). This ensures T has required properties while remaining flexible.',
        seed: 21,
      },
    ];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      db.prepare(
        `INSERT INTO chunks (conversation_id, chunk_index, role, content, page_number, embedding)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        chunk.conv,
        i,
        chunk.role,
        chunk.content,
        1,
        createEmbedding(chunk.seed)
      );
    }
  }

  describe('FTS Search', () => {
    it('finds chunks by keyword', () => {
      const results = searchFTS('useState', {});
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('useState');
    });

    it('respects project filter', () => {
      const results = searchFTS('async', { project: 'backend' });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.project === 'backend')).toBe(true);
    });

    it('respects role filter', () => {
      const results = searchFTS('typescript', { role: 'assistant' });
      expect(results.every((r) => r.role === 'assistant')).toBe(true);
    });
  });

  describe('Vector Search', () => {
    it('finds similar chunks by embedding', () => {
      // Query with embedding similar to React hooks content
      const queryEmbedding = createEmbedding(1.5);
      const results = searchVector(queryEmbedding, {});

      expect(results.length).toBeGreaterThan(0);
      // Should rank React hooks content higher (seeds 1, 2 are closer to 1.5)
    });

    it('respects project filter', () => {
      const queryEmbedding = createEmbedding(1);
      const results = searchVector(queryEmbedding, { project: 'web-dev' });

      expect(results.every((r) => r.project === 'web-dev')).toBe(true);
    });
  });

  describe('Hybrid Search', () => {
    it('returns FTS-only results without embedding client', async () => {
      const result = await searchHybrid('useState', {});

      expect(result.type).toBe('fts_only');
      expect(result.embeddingStatus).toBe('unavailable');
      expect(result.results!.length).toBeGreaterThan(0);
    });

    it('returns recent conversations for empty query', async () => {
      const result = await searchHybrid('', {});

      expect(result.type).toBe('recent');
      expect(result.conversations).toBeDefined();
    });
  });

  describe('Snippet Generation', () => {
    it('generates snippet around search term', () => {
      const content =
        'useState manages local state while useEffect handles side effects. This is a longer text to test truncation behavior.';
      const snippet = generateSnippet(content, 'useEffect', 30);

      expect(snippet).toContain('useEffect');
      expect(snippet.length).toBeLessThan(content.length);
    });

    it('highlights search terms in snippets', () => {
      const content = 'useState manages local state';
      const highlighted = highlightTerms(content, ['useState']);

      expect(highlighted).toContain('<strong>useState</strong>');
    });
  });

  describe('Full Pipeline', () => {
    it('complete search flow works end-to-end', async () => {
      // 1. Search for a term
      const searchResult = await searchHybrid('hooks', {});

      expect(searchResult.results).toBeDefined();

      if (searchResult.results && searchResult.results.length > 0) {
        const firstResult = searchResult.results[0];

        // 2. Verify result structure
        expect(firstResult).toHaveProperty('chunk_id');
        expect(firstResult).toHaveProperty('conversation_id');
        expect(firstResult).toHaveProperty('title');
        expect(firstResult).toHaveProperty('project');
        expect(firstResult).toHaveProperty('content');

        // 3. Generate snippet for display
        const snippet = generateSnippet(firstResult.content, 'hooks', 150);
        expect(snippet.length).toBeLessThanOrEqual(153); // 150 + "..."
      }
    });

    it('filters work across the pipeline', async () => {
      // Search in specific project with role filter
      const result = await searchHybrid('async', {
        project: 'backend',
        role: 'assistant',
      });

      expect(result.results).toBeDefined();
      if (result.results && result.results.length > 0) {
        expect(result.results.every((r) => r.project === 'backend')).toBe(true);
        expect(result.results.every((r) => r.role === 'assistant')).toBe(true);
      }
    });
  });
});
