export interface ChunkOptions {
  maxTokens: number;
  overlap: number;
}

const CHARS_PER_TOKEN = 4;

export function chunkText(text: string, opts: ChunkOptions): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const maxChars = opts.maxTokens * CHARS_PER_TOKEN;
  const overlapChars = opts.overlap * CHARS_PER_TOKEN;

  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < trimmed.length) {
    let end = Math.min(pos + maxChars, trimmed.length);

    if (end < trimmed.length) {
      end = findBreakPoint(trimmed, pos, end);
    }

    const chunk = trimmed.slice(pos, end).trim();
    if (chunk) chunks.push(chunk);

    pos = Math.max(pos + 1, end - overlapChars);
  }

  return chunks.length ? chunks : [trimmed];
}

function findBreakPoint(text: string, start: number, end: number): number {
  const segment = text.slice(start, end);
  const minPos = Math.floor(segment.length * 0.3);

  const paraIdx = segment.lastIndexOf('\n\n');
  if (paraIdx > minPos) return start + paraIdx + 2;

  const fenceIdx = segment.lastIndexOf('```\n');
  if (fenceIdx > minPos) return start + fenceIdx + 4;

  const lineIdx = segment.lastIndexOf('\n');
  if (lineIdx > minPos) return start + lineIdx + 1;

  const sentenceIdx = segment.lastIndexOf('. ');
  if (sentenceIdx > minPos) return start + sentenceIdx + 2;

  const wordIdx = segment.lastIndexOf(' ');
  if (wordIdx > minPos) return start + wordIdx + 1;

  return end;
}
