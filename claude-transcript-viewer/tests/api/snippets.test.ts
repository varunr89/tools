import { describe, it, expect } from 'vitest';
import { generateSnippet, highlightTerms } from '../../src/api/snippets';

describe('Snippet Generation', () => {
  it('should extract context around match', () => {
    const content = 'before before before async await after after after';
    const snippet = generateSnippet(content, 'async', 20);
    expect(snippet).toContain('async');
  });

  it('should add ellipsis when truncating', () => {
    const content = 'A'.repeat(100) + ' async ' + 'B'.repeat(100);
    const snippet = generateSnippet(content, 'async', 20);
    expect(snippet).toContain('...');
  });

  it('should handle match at start', () => {
    const content = 'async is at the start of this text';
    const snippet = generateSnippet(content, 'async', 50);
    expect(snippet.startsWith('async')).toBe(true);
  });

  it('should handle match at end', () => {
    const content = 'this text ends with async';
    const snippet = generateSnippet(content, 'async', 50);
    expect(snippet.endsWith('async')).toBe(true);
  });

  it('should return truncated content when no match', () => {
    const content = 'some content without the search term';
    const snippet = generateSnippet(content, 'notfound', 20);
    expect(snippet.length).toBeLessThanOrEqual(50);
  });

  it('should handle multiple search terms', () => {
    const content = 'async await promises are great';
    const snippet = generateSnippet(content, 'async await', 50);
    expect(snippet).toContain('async');
  });
});

describe('Term Highlighting', () => {
  it('should wrap terms in markdown bold', () => {
    const highlighted = highlightTerms('use async here', ['async']);
    expect(highlighted).toBe('use **async** here');
  });

  it('should highlight multiple terms', () => {
    const highlighted = highlightTerms('async and await', ['async', 'await']);
    expect(highlighted).toBe('**async** and **await**');
  });

  it('should be case-insensitive', () => {
    const highlighted = highlightTerms('ASYNC code', ['async']);
    expect(highlighted).toBe('**ASYNC** code');
  });

  it('should handle regex special characters in terms', () => {
    const highlighted = highlightTerms('test (parens) here', ['(parens)']);
    expect(highlighted).toBe('test **(parens)** here');
  });

  it('should not double-highlight', () => {
    const highlighted = highlightTerms('async async', ['async']);
    expect(highlighted).toBe('**async** **async**');
  });
});
