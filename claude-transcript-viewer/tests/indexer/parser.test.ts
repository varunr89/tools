import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { parseTranscript, extractConversationMetadata } from '../../src/indexer/parser';

const FIXTURE = join(__dirname, '../fixtures/sample.jsonl');

describe('Parser', () => {
  it('should parse user messages', () => {
    const msgs = parseTranscript(FIXTURE).filter(m => m.role === 'user');
    expect(msgs).toHaveLength(2);
  });

  it('should parse assistant text messages', () => {
    const msgs = parseTranscript(FIXTURE).filter(m => m.role === 'assistant');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('Async/await');
  });

  it('should exclude tool_use content blocks', () => {
    const msgs = parseTranscript(FIXTURE);
    expect(msgs.some(m => m.content.includes('Read'))).toBe(false);
  });

  it('should exclude result entries', () => {
    const msgs = parseTranscript(FIXTURE);
    expect(msgs.some(m => m.content.includes('tool output'))).toBe(false);
  });

  it('should preserve message order', () => {
    const msgs = parseTranscript(FIXTURE);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[0].index).toBe(0);
    expect(msgs[1].index).toBe(1);
  });

  it('should handle array content blocks', () => {
    const msgs = parseTranscript(FIXTURE);
    const assistant = msgs.find(m => m.role === 'assistant');
    expect(assistant?.content).toBe('Async/await handles promises.');
  });

  it('should handle string content', () => {
    const msgs = parseTranscript(FIXTURE);
    const user = msgs.find(m => m.role === 'user');
    expect(user?.content).toBe('How do I use async/await?');
  });

  it('should skip malformed JSON lines', () => {
    expect(() => parseTranscript(FIXTURE)).not.toThrow();
  });
});

describe('Metadata Extraction', () => {
  it('should extract conversation metadata from fixture', () => {
    const meta = extractConversationMetadata(FIXTURE);
    expect(meta.messageCount).toBeGreaterThan(0);
  });
});
