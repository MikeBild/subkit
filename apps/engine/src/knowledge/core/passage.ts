const DEFAULT_PASSAGE_CHARS = 300;
const LEAD_CHARS = 40;
const MIN_TERM_CHARS = 3;

export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= MIN_TERM_CHARS) terms.add(raw);
  }
  return [...terms];
}

function termPositions(haystack: string, term: string): number[] {
  const out: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(term, from);
    if (at === -1) break;
    out.push(at);
    from = at + term.length;
  }
  return out;
}

export function bestPassage(content: string, query: string, max = DEFAULT_PASSAGE_CHARS): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  const hits: Array<{ at: number; term: string }> = [];
  for (const term of queryTerms(query)) {
    for (const at of termPositions(lower, term)) hits.push({ at, term });
  }
  hits.sort((a, b) => a.at - b.at);
  let bestStart = 0;
  let bestCount = 0;
  for (const hit of hits) {
    const start = Math.max(0, hit.at - LEAD_CHARS);
    const end = start + max;
    const covered = new Set<string>();
    for (const other of hits) {
      if (other.at >= start && other.at + other.term.length <= end) covered.add(other.term);
    }
    if (covered.size > bestCount) {
      bestCount = covered.size;
      bestStart = start;
    }
  }
  let start = Math.min(bestStart, text.length - max);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space - start < LEAD_CHARS) start = space + 1;
  }
  let end = Math.min(text.length, start + max);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + max / 2) end = space;
  }
  return text.slice(start, end).trim();
}
