export type CountIssueKind = "arithmetic" | "over_enumeration";

export interface CountIssue {
  kind: CountIssueKind;
  detail: string;
}

function stem(noun: string): string {
  const n = noun.toLowerCase();
  return n.endsWith("s") ? n.slice(0, -1) : n;
}

const HEDGE_RE =
  /^\(|\b(keine\s+(weitere|weiteren|andere|anderen)|none|no\s+(more|other|others|further)|nichts\s+weiter)\b/iu;

const TRUNCATION_RE =
  /\b(top|first|erste|ersten|letzte|letzten|last|showing|zeige|zeigt|sample|up\s+to|bis\s+zu|at\s+least|mindestens|about|etwa|ca|approx|roughly)\s*$/iu;

const BREAKDOWN_RE =
  /(\d+)\b[^\n(){}=:+]{0,60}?[:=(]\s*((?:\d+\s+[\p{L}][\p{L}-]*\s*\+\s*)+\d+\s+[\p{L}][\p{L}-]*)/giu;

const NUM_NOUN_RE = /(\d+)\s+[\p{L}][\p{L}-]*/gu;

const MAX_COUNT = 1_000_000;
const toCount = (s: string | undefined): number => Number.parseInt(s ?? "", 10);

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

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const header =
      line.match(/([\p{L}][\p{L}-]{2,}):\s*$/u) ?? line.match(/^\s*([\p{L}][\p{L}-]{2,})\s*$/u);
    if (!header) continue;
    let substantive = 0;
    let bullets = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const b = (lines[j] ?? "").match(/^\s*[•\-*]\s+(.*\S)\s*$/u);
      if (!b) break;
      bullets++;
      if (!HEDGE_RE.test((b[1] ?? "").trim())) substantive++;
    }
    if (bullets > 0) {
      sections.push({ stem: stem(header[1] ?? ""), substantive, total_bullets: bullets });
    }
  }
  return sections;
}

function detectOverEnumeration(text: string): CountIssue[] {
  const lines = text.split("\n");
  const sections = parseSections(lines);
  if (sections.length === 0) return [];
  const bySection = new Map<string, Section>();
  for (const s of sections) if (!bySection.has(s.stem)) bySection.set(s.stem, s);

  const issues: CountIssue[] = [];
  const claimRe = /(\d+)\s+([\p{L}][\p{L}-]{2,})/gu;
  const seen = new Set<string>();
  for (const m of text.matchAll(claimRe)) {
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 20), idx);
    if (TRUNCATION_RE.test(before)) continue;
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

export function detectCountInconsistencies(text: string): CountIssue[] {
  if (!text) return [];
  return [...detectArithmetic(text), ...detectOverEnumeration(text)];
}
