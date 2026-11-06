import type { components } from "@cli-core/engine-api/openapi";

export type ConversationReference = components["schemas"]["ConversationReference"];
export type ConversationReferenceType = ConversationReference["type"];

export const MENTION_TRIGGER = "@";

const LABEL_RE = /^[\p{L}\p{N} _./-]{1,200}$/u;

const TOKEN_CONTINUATION = /[\p{L}\p{N}_./-]/u;

const CATEGORY_MENTION_PREFIX = "kategorie/";

export function categoryMentionToken(category: string): string {
  return `${MENTION_TRIGGER}${CATEGORY_MENTION_PREFIX}${category}`;
}

export interface MentionQuery {
  start: number;
  query: string;
}

export function mentionTokenText(reference: Pick<ConversationReference, "label">): string {
  return `${MENTION_TRIGGER}${reference.label}`;
}

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

export function insertMention(
  text: string,
  start: number,
  caret: number,
  reference: ConversationReference,
): { text: string; caret: number } {
  return insertMentionText(text, start, caret, mentionTokenText(reference));
}

export function insertMentionText(
  text: string,
  start: number,
  caret: number,
  tokenText: string,
): { text: string; caret: number } {
  const token = `${tokenText} `;
  const next = text.slice(0, start) + token + text.slice(caret);
  return { text: next, caret: start + token.length };
}

interface MentionTokenMatch {
  start: number;
  end: number;
  reference: ConversationReference;
}

function hasTokenBoundaries(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : text[start - 1];
  if (before && !/\s/.test(before)) return false;
  const after = end >= text.length ? "" : text[end];
  if (!after) return true;
  if (after === ".") {
    const afterDot = end + 1 >= text.length ? "" : text[end + 1];
    return !(afterDot && TOKEN_CONTINUATION.test(afterDot));
  }
  return !TOKEN_CONTINUATION.test(after);
}

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

export function reconcileReferences(
  text: string,
  references: readonly ConversationReference[],
): ConversationReference[] {
  const present = new Set(
    scanMentionTokens(text, references).map((m) => `${m.reference.type}:${m.reference.id}`),
  );
  return references.filter((r) => present.has(`${r.type}:${r.id}`));
}

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

interface MentionSegment {
  text: string;
  reference?: ConversationReference;
}

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

export function findTokenAt(
  text: string,
  references: readonly ConversationReference[],
  index: number,
): MentionTokenMatch | null {
  if (index < 0 || index >= text.length) return null;
  return scanMentionTokens(text, references).find((m) => index >= m.start && index < m.end) ?? null;
}

export function isInsideMentionToken(
  text: string,
  references: readonly ConversationReference[],
  caret: number,
): boolean {
  return scanMentionTokens(text, references).some((m) => caret > m.start && caret < m.end);
}

export function isMentionableLabel(label: string): boolean {
  return LABEL_RE.test(label) && !/\s/.test(label);
}

export type MentionCandidateType = ConversationReferenceType | "category" | "file";

export interface MentionCandidate {
  type: MentionCandidateType;
  id: string;
  label: string;
  title: string;
  count?: number;
  size?: number;
  contentType?: string | null;
}

export function categoryCandidates(
  categories: readonly { category: string; count: number }[],
  query: string,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  return categories
    .filter((entry) => isMentionableLabel(entry.category))
    .map((entry) => ({
      type: "category" as const,
      id: entry.category,
      label: `${CATEGORY_MENTION_PREFIX}${entry.category}`,
      title: entry.category,
      count: entry.count,
    }))
    .filter(
      (candidate) =>
        !needle ||
        candidate.label.toLowerCase().includes(needle) ||
        candidate.title.toLowerCase().includes(needle),
    );
}

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

export function candidateToReference(
  candidate: MentionCandidate & { type: ConversationReferenceType },
): ConversationReference {
  return { type: candidate.type, id: candidate.id, label: candidate.label };
}

export function isReferenceCandidate(
  candidate: MentionCandidate,
): candidate is MentionCandidate & { type: ConversationReferenceType } {
  return candidate.type !== "category" && candidate.type !== "file";
}
