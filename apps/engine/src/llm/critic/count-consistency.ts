// Deterministic numeric / enumeration consistency checks for assistant chat
// text. The chat critic already grounds ids and runtime values, but it never
// checked whether the assistant's OWN counts add up — so a destructive
// bulk-delete summary like
//
//   "Alle 5 Acme-Ferries-Ressourcen (3 Workflows + 2 Connectors)"   ← only 2 workflows existed
//   "Alle 5 … gelöscht: 2 Workflows + 2 Connectors"                    ← 5 ≠ 2+2
//
// passed with confidence 1. These two functions catch both classes:
//
//   A (arithmetic)        — a stated total that does not equal the sum of its
//                           itemised parts. Requires the explicit "a X + b Y"
//                           sum notation, so ordinary prose ("3 months and 1
//                           week ago") is never matched.
//   B (over-enumeration)  — a stated count of a resource type that is LARGER
//                           than the number of SUBSTANTIVE items actually
//                           listed for it. The model claims "3 Workflows" then
//                           lists 2 real bullets plus a hedge bullet
//                           ("(keine weiteren …)") to pad the gap — the hedge
//                           bullet does not count.
//
// Both are conservative: each fires ONLY on an explicit structure (a `+`-joined
// breakdown, or a "<Noun>:" header followed by a bullet list). They never
// flag a number mentioned in passing, and B only fires on OVER-claims
// (stated > shown) without a truncation qualifier ("top 5", "showing 3", …),
// so "Top 5 repos: • a • b • c" is fine.

export type CountIssueKind = "arithmetic" | "over_enumeration";

export interface CountIssue {
  kind: CountIssueKind;
  detail: string;
}

/** Singular stem: lowercased, one trailing "s" removed. Workflows → workflow. */
function stem(noun: string): string {
  const n = noun.toLowerCase();
  return n.endsWith("s") ? n.slice(0, -1) : n;
}

// A bullet whose content is a hedge/filler line rather than a real item:
// leading "(" (parenthetical aside) or a "no more / none / keine weiteren"
// phrasing. These are how a model pads a list to a claimed-but-wrong count.
const HEDGE_RE =
  /^\(|\b(keine\s+(weitere|weiteren|andere|anderen)|none|no\s+(more|other|others|further)|nichts\s+weiter)\b/iu;

// Truncation qualifier immediately before a count means the list is
// DELIBERATELY shorter than the number ("top 5", "showing 3", "first 10").
const TRUNCATION_RE =
  /\b(top|first|erste|ersten|letzte|letzten|last|showing|zeige|zeigt|sample|up\s+to|bis\s+zu|at\s+least|mindestens|about|etwa|ca|approx|roughly)\s*$/iu;

// A "total [: = (] a X + b Y [+ …]" breakdown. The joiner is restricted to
// "+" (the sum notation) on purpose — it is what people write for explicit
// counts and almost never appears between unrelated numbers in prose.
const BREAKDOWN_RE =
  /(\d+)\b[^\n(){}=:+]{0,60}?[:=(]\s*((?:\d+\s+[\p{L}][\p{L}-]*\s*\+\s*)+\d+\s+[\p{L}][\p{L}-]*)/giu;

const NUM_NOUN_RE = /(\d+)\s+[\p{L}][\p{L}-]*/gu;

// Cap parsed counts well below float-precision loss. A "count" larger than
// this is not a real resource tally; ignore it rather than risk a bogus verdict.
const MAX_COUNT = 1_000_000;
const toCount = (s: string | undefined): number => Number.parseInt(s ?? "", 10);

/** A: stated total ≠ sum of its `+`-joined itemised parts. */
function detectArithmetic(text: string): CountIssue[] {
  const issues: CountIssue[] = [];
  for (const m of text.matchAll(BREAKDOWN_RE)) {
    const total = toCount(m[1]);
    const parts = [...(m[2] ?? "").matchAll(NUM_NOUN_RE)].map((p) => toCount(p[1]));
    if (parts.length < 2) continue;
    if (total > MAX_COUNT || parts.some((p) => p > MAX_COUNT)) continue;
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum !== total) {
      issues.push({
        kind: "arithmetic",
        detail: `stated total ${total} ≠ sum of parts ${parts.join("+")}=${sum} ("${m[0].trim()}")`,
      });
    }
  }
  return issues;
}

interface Section {
  stem: string;
  substantive: number;
  total_bullets: number;
}

/** Parse "<Noun>:" headers each followed by a contiguous bullet list. */
function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // A section header is either a line that ENDS with "<noun>:" (e.g.
    // "Workflows:" or "Das sind 3 Workflows:") or a bare "<noun>" line.
    const header =
      line.match(/([\p{L}][\p{L}-]{2,}):\s*$/u) ?? line.match(/^\s*([\p{L}][\p{L}-]{2,})\s*$/u);
    if (!header) continue;
    let substantive = 0;
    let bullets = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const b = (lines[j] ?? "").match(/^\s*[•\-*]\s+(.*\S)\s*$/u);
      if (!b) break; // first non-bullet line ends the section
      bullets++;
      if (!HEDGE_RE.test((b[1] ?? "").trim())) substantive++;
    }
    if (bullets > 0) {
      sections.push({ stem: stem(header[1] ?? ""), substantive, total_bullets: bullets });
    }
  }
  return sections;
}

/** B: a "<N> <Noun>" claim whose matching bullet section lists FEWER
 *  substantive items than N (the model padded the list with hedge bullets). */
function detectOverEnumeration(text: string): CountIssue[] {
  const lines = text.split("\n");
  const sections = parseSections(lines);
  if (sections.length === 0) return [];
  const bySection = new Map<string, Section>();
  for (const s of sections) if (!bySection.has(s.stem)) bySection.set(s.stem, s);

  const issues: CountIssue[] = [];
  // "<N> <noun>" claim. The `{2,}` noun floor avoids matching short
  // prepositions/particles (de "im"/"am", en "of"), so a count of 1 over a
  // 1-char noun is intentionally not graded — the false-positive cost there
  // outweighs the rare real catch.
  const claimRe = /(\d+)\s+([\p{L}][\p{L}-]{2,})/gu;
  const seen = new Set<string>();
  for (const m of text.matchAll(claimRe)) {
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 20), idx);
    if (TRUNCATION_RE.test(before)) continue; // "top 5", "showing 3", …
    const count = toCount(m[1]);
    if (count > MAX_COUNT) continue;
    const s = bySection.get(stem(m[2] ?? ""));
    if (!s) continue;
    const key = `${stem(m[2] ?? "")}:${count}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (count > s.substantive) {
      issues.push({
        kind: "over_enumeration",
        detail: `claimed ${count} ${m[2]} but only ${s.substantive} substantive item(s) listed (${s.total_bullets} bullet(s), the rest are hedge/filler)`,
      });
    }
  }
  return issues;
}

/**
 * Detect numeric/enumeration self-inconsistencies in assistant chat text.
 * Returns an empty array for clean text. Pure — no I/O.
 */
export function detectCountInconsistencies(text: string): CountIssue[] {
  if (!text) return [];
  return [...detectArithmetic(text), ...detectOverEnumeration(text)];
}
