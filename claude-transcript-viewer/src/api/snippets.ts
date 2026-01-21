export function generateSnippet(content: string, query: string, contextChars = 75): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();

  let matchIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
      matchIdx = idx;
    }
  }

  if (matchIdx === -1) {
    const maxLen = contextChars * 2;
    return content.length > maxLen
      ? content.slice(0, maxLen) + '...'
      : content;
  }

  const start = Math.max(0, matchIdx - contextChars);
  const end = Math.min(content.length, matchIdx + contextChars);

  let snippet = content.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

export function highlightTerms(text: string, terms: string[]): string {
  let result = text;

  for (const term of terms) {
    if (!term) continue;

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    result = result.replace(regex, '**$1**');
  }

  return result;
}
