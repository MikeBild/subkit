import { normalizeForQuote } from "@shared/quote-text.ts";

export interface SearchableNote {
  readonly id: string;
  readonly text: string;
  readonly abstract: string | null;
  readonly confirmed: boolean;
  readonly updated_at: Date;
}

export interface NoteHit<T extends SearchableNote> {
  readonly note: T;
  readonly score: number;
}

const MIN_TOKEN_CHARS = 3;

export function searchTokens(text: string): string[] {
  const folded = normalizeForQuote(text);
  const tokens = folded.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= MIN_TOKEN_CHARS);
  return [...new Set(tokens)];
}

function overlap(query: readonly string[], haystack: ReadonlySet<string>): number {
  let hits = 0;
  for (const token of query) if (haystack.has(token)) hits += 1;
  return hits;
}

export function scoreNote(queryTokens: readonly string[], note: SearchableNote): number {
  if (queryTokens.length === 0) return 0;
  const body = new Set(searchTokens(note.text));
  const summary = new Set(searchTokens(note.abstract ?? ""));
  const hits = overlap(queryTokens, new Set([...body, ...summary]));
  if (hits === 0) return 0;
  const inSummary = overlap(queryTokens, summary);
  return (hits + inSummary * 0.5) / queryTokens.length;
}

export function rankNotes<T extends SearchableNote>(
  notes: readonly T[],
  query: string,
  limit: number,
): NoteHit<T>[] {
  const queryTokens = searchTokens(query);
  return notes
    .map((note) => ({ note, score: scoreNote(queryTokens, note) }))
    .filter((hit) => hit.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.note.confirmed) - Number(a.note.confirmed) ||
        b.note.updated_at.getTime() - a.note.updated_at.getTime() ||
        a.note.id.localeCompare(b.note.id),
    )
    .slice(0, Math.max(0, limit));
}
