import { describe, it, expect } from 'vitest';
import { mergeResultsRRF, SearchResult } from '../../src/api/search.js';

function makeResult(chunk_id: number, content: string): SearchResult {
  return {
    chunk_id,
    conversation_id: 'conv1',
    title: 'Test',
    project: 'project',
    role: 'user',
    content,
    page_number: 1,
    score: 0,
  };
}

describe('RRF Merge', () => {
  it('should merge results from both sources', () => {
    const vectorResults = [
      makeResult(1, 'first vector'),
      makeResult(2, 'second vector'),
    ];
    const ftsResults = [
      makeResult(3, 'first fts'),
      makeResult(4, 'second fts'),
    ];

    const merged = mergeResultsRRF(vectorResults, ftsResults, { limit: 10 });

    expect(merged.length).toBe(4);
    // All results should be present
    expect(merged.map((r) => r.chunk_id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('should boost documents appearing in both result sets', () => {
    const vectorResults = [
      makeResult(1, 'appears in both'),
      makeResult(2, 'only vector'),
    ];
    const ftsResults = [
      makeResult(1, 'appears in both'), // Same chunk_id
      makeResult(3, 'only fts'),
    ];

    const merged = mergeResultsRRF(vectorResults, ftsResults, { limit: 10 });

    // chunk_id 1 should be first because it appears in both
    expect(merged[0].chunk_id).toBe(1);
    // Its score should be higher (combined from both)
    expect(merged[0].score).toBeGreaterThan(merged[1].score);
  });

  it('should respect limit parameter', () => {
    const vectorResults = Array.from({ length: 10 }, (_, i) =>
      makeResult(i, `vector ${i}`)
    );
    const ftsResults = Array.from({ length: 10 }, (_, i) =>
      makeResult(i + 100, `fts ${i}`)
    );

    const merged = mergeResultsRRF(vectorResults, ftsResults, { limit: 5 });

    expect(merged.length).toBe(5);
  });

  it('should handle empty vector results (FTS fallback)', () => {
    const vectorResults: SearchResult[] = [];
    const ftsResults = [
      makeResult(1, 'fts only'),
      makeResult(2, 'fts second'),
    ];

    const merged = mergeResultsRRF(vectorResults, ftsResults, { limit: 10 });

    expect(merged.length).toBe(2);
    expect(merged[0].chunk_id).toBe(1);
  });

  it('should handle empty FTS results', () => {
    const vectorResults = [
      makeResult(1, 'vector only'),
      makeResult(2, 'vector second'),
    ];
    const ftsResults: SearchResult[] = [];

    const merged = mergeResultsRRF(vectorResults, ftsResults, { limit: 10 });

    expect(merged.length).toBe(2);
    expect(merged[0].chunk_id).toBe(1);
  });

  it('should use k=60 for ranking by default', () => {
    // With k=60, rank 0 gives 1/60, rank 1 gives 1/61
    // Document appearing at rank 0 in both should get 1/60 + 1/60 = 2/60
    // Document appearing at rank 0 in one should get 1/60
    const vectorResults = [makeResult(1, 'shared')];
    const ftsResults = [makeResult(1, 'shared')];

    const merged = mergeResultsRRF(vectorResults, ftsResults, { limit: 10 });

    // Score should be approximately 2/60 = 0.0333...
    expect(merged[0].score).toBeCloseTo(2 / 60, 4);
  });

  it('should allow custom k value', () => {
    const vectorResults = [makeResult(1, 'test')];
    const ftsResults = [makeResult(1, 'test')];

    const merged = mergeResultsRRF(vectorResults, ftsResults, {
      limit: 10,
      k: 10,
    });

    // With k=10, score should be 2/10 = 0.2
    expect(merged[0].score).toBeCloseTo(2 / 10, 4);
  });

  it('should preserve result metadata from first occurrence', () => {
    const vectorResults = [
      {
        ...makeResult(1, 'vector content'),
        title: 'Vector Title',
        project: 'vector-project',
      },
    ];
    const ftsResults = [
      {
        ...makeResult(1, 'fts content'),
        title: 'FTS Title',
        project: 'fts-project',
      },
    ];

    const merged = mergeResultsRRF(vectorResults, ftsResults, { limit: 10 });

    // Should preserve metadata from vector (first seen)
    expect(merged[0].title).toBe('Vector Title');
    expect(merged[0].project).toBe('vector-project');
    expect(merged[0].content).toBe('vector content');
  });
});
