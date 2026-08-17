/**
 * Simple text chunking utility.
 * Splits text at paragraph/word boundaries within a character limit.
 */

export function chunkText(text: string, limit: number): string[] {
  if (!text) return [];
  if (limit <= 0 || text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    // Find best break point: prefer last newline, then last whitespace
    let breakIdx = -1;
    let lastWhitespace = -1;

    for (let i = window.length - 1; i > 0; i--) {
      if (window[i] === '\n' && breakIdx < 0) {
        breakIdx = i;
        break;
      }
      if (lastWhitespace < 0 && /\s/.test(window[i]!)) {
        lastWhitespace = i;
      }
    }

    if (breakIdx <= 0) breakIdx = lastWhitespace > 0 ? lastWhitespace : limit;

    // Never cut between a surrogate pair: the resulting half-character encodes
    // to invalid UTF-8 and Telegram rejects the whole message with HTTP 400.
    // Move the boundary back, or forward when moving back would stall progress.
    const hi = remaining.charCodeAt(breakIdx - 1);
    const lo = remaining.charCodeAt(breakIdx);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
      breakIdx = breakIdx > 1 ? breakIdx - 1 : breakIdx + 1;
    }

    const chunk = remaining.slice(0, breakIdx).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);

    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]!);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }

  if (remaining.length) chunks.push(remaining);
  return chunks;
}
