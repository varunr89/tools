export function generateSnippet(content: string, query: string, contextChars = 75): string {
  // Strip markdown bold markers to avoid double-highlighting
  const cleanContent = content.replace(/\*\*/g, '');
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = cleanContent.toLowerCase();

  let matchIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
      matchIdx = idx;
    }
  }

  if (matchIdx === -1) {
    const maxLen = contextChars * 2;
    return cleanContent.length > maxLen
      ? cleanContent.slice(0, maxLen) + '...'
      : cleanContent;
  }

  const start = Math.max(0, matchIdx - contextChars);
  const end = Math.min(cleanContent.length, matchIdx + contextChars);

  let snippet = cleanContent.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < cleanContent.length) snippet = snippet + '...';

  return snippet;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function highlightTerms(text: string, terms: string[]): string {
  // First escape HTML to prevent XSS
  let result = escapeHtml(text);

  // Then wrap matched terms in <strong> tags
  for (const term of terms) {
    if (!term) continue;

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    result = result.replace(regex, '<strong>$1</strong>');
  }

  return result;
}
