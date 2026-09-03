// `@`-mentions in the composer: the text keeps a readable token, the
// structured reference travels beside it.
//
// One scanner (`scanMentionTokens`) is the single source of truth for
// "where in this text are mention tokens". The chip overlay, whole-token
// deletion and reference reconciliation all build on it, which is what
// keeps the three from disagreeing about what counts as a token — the
// failure mode being `@sync` shadowing `@sync-orders`, or a match inside
// an e-mail address.

import type { components } from "@/api/schema";

export type ConversationReference = components["schemas"]["ConversationReference"];
export type ConversationReferenceType = ConversationReference["type"];

/** Prefix that opens the picker. */
export const MENTION_TRIGGER = "@";

/** Same character set the engine accepts for a label. */
const LABEL_RE = /^[\p{L}\p{N} _./-]{1,200}$/u;

/** Characters that continue a token word; a candidate followed by one of
 *  these is part of a longer word (`@sync` inside `@sync-orders`). */
const TOKEN_CONTINUATION = /[\p{L}\p{N}_.-]/u;

export interface MentionQuery {
  /** Index of the trigger character in the text. */
  start: number;
  /** Everything typed between the trigger and the caret. */
  query: string;
}

/** The token written into the composer for a reference, e.g. `@customer-sync`. */
export function mentionTokenText(reference: Pick<ConversationReference, "label">): string {
  return `${MENTION_TRIGGER}${reference.label}`;
}

/**
 * Detects whether the caret sits inside an unfinished `@…` token. A mention
 * only starts at the beginning of the text or after whitespace, so an
 * e-mail address never opens the picker; a space closes the query.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const start = before.lastIndexOf(MENTION_TRIGGER);
  if (start === -1) return null;
  const charBefore = start === 0 ? "" : before[start - 1];
  if (charBefore && !/\s/.test(charBefore)) return null;
  const query = before.slice(start + MENTION_TRIGGER.length);
  if (/\s/.test(query)) return null;
  return { start, query };
}

/** Replaces the in-progress token with the final one; returns the caret to restore. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  reference: ConversationReference,
): { text: string; caret: number } {
  const token = `${mentionTokenText(reference)} `;
  const next = text.slice(0, start) + token + text.slice(caret);
  return { text: next, caret: start + token.length };
}

export interface MentionTokenMatch {
  start: number;
  end: number;
  reference: ConversationReference;
}

function hasTokenBoundaries(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : text[start - 1];
  if (before && !/\s/.test(before)) return false;
  const after = end >= text.length ? "" : text[end];
  if (!after) return true;
  // A dot is a label character (`stripe.prod`), but a dot that ends the
  // sentence is punctuation: `run @customer-sync.` must still be a token.
  if (after === ".") {
    const afterDot = end + 1 >= text.length ? "" : text[end + 1];
    return !(afterDot && TOKEN_CONTINUATION.test(afterDot));
  }
  return !TOKEN_CONTINUATION.test(after);
}

/**
 * Longest tokens claim their ranges first (a token that is a prefix of
 * another can never shadow it), candidates need word boundaries on both
 * sides, and claimed ranges never overlap. References that share one
 * label are grouped and occurrences are distributed across the group.
 */
export function scanMentionTokens(
  text: string,
  references: readonly ConversationReference[],
): MentionTokenMatch[] {
  if (!text || references.length === 0) return [];
  const groups = new Map<string, ConversationReference[]>();
  for (const reference of references) {
    const token = mentionTokenText(reference);
    const group = groups.get(token);
    if (group) group.push(reference);
    else groups.set(token, [reference]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[0].length - a[0].length);
  const matches: MentionTokenMatch[] = [];
  const overlaps = (start: number, end: number) =>
    matches.some((m) => start < m.end && m.start < end);
  for (const [token, group] of ordered) {
    let occurrence = 0;
    let from = text.indexOf(token);
    while (from !== -1) {
      const to = from + token.length;
      if (hasTokenBoundaries(text, from, to) && !overlaps(from, to)) {
        const reference = group[occurrence % group.length];
        if (reference) matches.push({ start: from, end: to, reference });
        occurrence += 1;
      }
      from = text.indexOf(token, from + 1);
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Drops references whose token no longer appears — deleting `@customer-sync`
 *  by hand also removes the structured reference. */
export function reconcileReferences(
  text: string,
  references: readonly ConversationReference[],
): ConversationReference[] {
  const present = new Set(
    scanMentionTokens(text, references).map((m) => `${m.reference.type}:${m.reference.id}`),
  );
  return references.filter((r) => present.has(`${r.type}:${r.id}`));
}

/** Mentioning the same object twice sends it once. */
export function dedupeReferences(
  references: readonly ConversationReference[],
): ConversationReference[] {
  const seen = new Set<string>();
  return references.filter((r) => {
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface MentionSegment {
  text: string;
  reference?: ConversationReference;
}

/** Splits text into plain runs and mention tokens for chip rendering. */
export function splitByMentions(
  text: string,
  references: readonly ConversationReference[],
): MentionSegment[] {
  const matches = scanMentionTokens(text, references);
  if (matches.length === 0) return text ? [{ text }] : [];
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start) });
    segments.push({ text: text.slice(match.start, match.end), reference: match.reference });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/** The token covering a character index — one Backspace removes the whole reference. */
export function findTokenAt(
  text: string,
  references: readonly ConversationReference[],
  index: number,
): MentionTokenMatch | null {
  if (index < 0 || index >= text.length) return null;
  return scanMentionTokens(text, references).find((m) => index >= m.start && index < m.end) ?? null;
}

/** True when the caret sits strictly inside a completed token: a click there
 *  is not a query, and a selection would orphan the token's tail. A caret
 *  directly after the token is allowed — re-selection replaces it cleanly. */
export function isInsideMentionToken(
  text: string,
  references: readonly ConversationReference[],
  caret: number,
): boolean {
  return scanMentionTokens(text, references).some((m) => caret > m.start && caret < m.end);
}

/** A label that can be written as a token and will pass the engine's schema. */
export function isMentionableLabel(label: string): boolean {
  return LABEL_RE.test(label) && !/\s/.test(label);
}

/** Candidate entries the picker shows, before one becomes a reference. */
export interface MentionCandidate {
  type: ConversationReferenceType;
  id: string;
  /** The token text — a slug, so it survives as one word in the prose. */
  label: string;
  /** What the person reads next to the token: the display name. */
  title: string;
}

/** Prefix matches first, then substring matches, both on label and title. */
export function rankCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...candidates];
  const matches = candidates.filter((c) =>
    [c.label, c.title].some((field) => field.toLowerCase().includes(needle)),
  );
  return matches.sort((a, b) => {
    const aPrefix =
      a.label.toLowerCase().startsWith(needle) || a.title.toLowerCase().startsWith(needle);
    const bPrefix =
      b.label.toLowerCase().startsWith(needle) || b.title.toLowerCase().startsWith(needle);
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
    return 0;
  });
}

export function candidateToReference(candidate: MentionCandidate): ConversationReference {
  return { type: candidate.type, id: candidate.id, label: candidate.label };
}
