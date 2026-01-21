import { readFileSync } from 'fs';

export interface Message {
  index: number;
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationMetadata {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
}

export function parseTranscript(path: string): Message[] {
  const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
  const messages: Message[] = [];
  let idx = 0;

  for (const line of lines) {
    try {
      const p = JSON.parse(line);

      if (p.type === 'user' && p.message?.role === 'user') {
        const text = extractText(p.message.content);
        if (text) messages.push({ index: idx++, role: 'user', content: text });
      } else if (p.type === 'assistant' && p.message?.role === 'assistant') {
        const text = extractText(p.message.content);
        if (text) messages.push({ index: idx++, role: 'assistant', content: text });
      }
    } catch {
      // Skip malformed JSON lines
    }
  }
  return messages;
}

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is TextBlock => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

export function extractConversationMetadata(path: string): ConversationMetadata {
  const messages = parseTranscript(path);
  return {
    messageCount: messages.length,
    userMessageCount: messages.filter(m => m.role === 'user').length,
    assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
  };
}
