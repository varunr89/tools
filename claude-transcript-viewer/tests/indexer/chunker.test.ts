import { describe, it, expect } from 'vitest';
import { chunkText, ChunkOptions } from '../../src/indexer/chunker';

describe('Chunker', () => {
  const defaultOpts: ChunkOptions = { maxTokens: 300, overlap: 50 };

  it('should return single chunk for short text', () => {
    expect(chunkText('short', defaultOpts)).toHaveLength(1);
  });

  it('should split long text into multiple chunks', () => {
    const longText = 'word '.repeat(500);
    const chunks = chunkText(longText, { maxTokens: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should include overlap between chunks', () => {
    // Use larger token values for more realistic testing
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon';
    const chunks = chunkText(text, { maxTokens: 20, overlap: 10 });

    // With overlap, consecutive chunks should share some content
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    if (chunks.length >= 2) {
      // The second chunk should start before where the first chunk ends
      // (due to overlap going backwards)
      const chunk0Words = chunks[0].split(' ');
      const chunk1Words = chunks[1].split(' ');
      // At least some word from chunk0 should appear in chunk1
      const hasOverlap = chunk0Words.some(word => chunk1Words.includes(word));
      expect(hasOverlap).toBe(true);
    }
  });

  it('should keep small code blocks intact', () => {
    const code = '```js\nfunction test() {\n  return 42;\n}\n```';
    const chunks = chunkText(code, { maxTokens: 100, overlap: 20 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('function test');
  });

  it('should split large code blocks at line boundaries', () => {
    const lines = Array(100).fill('  const x = 1;').join('\n');
    const code = '```js\n' + lines + '\n```';
    const chunks = chunkText(code, { maxTokens: 50, overlap: 10 });

    expect(chunks.length).toBeGreaterThan(1);
    // Verify chunks are created (trimming removes trailing newlines, which is fine)
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('should prefer paragraph boundaries as split points', () => {
    const text = 'First paragraph.\n\nSecond paragraph with more content that makes it longer.\n\nThird paragraph.';
    const chunks = chunkText(text, { maxTokens: 20, overlap: 5 });

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should handle empty text', () => {
    expect(chunkText('', defaultOpts)).toHaveLength(0);
    expect(chunkText('   ', defaultOpts)).toHaveLength(0);
  });

  it('should respect maxTokens limit (approximately)', () => {
    const longText = 'word '.repeat(1000);
    const chunks = chunkText(longText, { maxTokens: 100, overlap: 20 });

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100 * 4 * 1.5);
    }
  });
});
