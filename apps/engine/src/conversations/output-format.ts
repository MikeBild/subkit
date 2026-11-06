type NamedOutputFormat = "markdown_table" | "csv" | "html" | "bulleted_list" | "json";

export function detectNamedOutputFormat(goal: string): NamedOutputFormat | null {
  const g = goal.toLowerCase();
  if (/\b(markdown|md)\s+table\b/.test(g)) return "markdown_table";
  if (/\bcsv\b/.test(g)) return "csv";
  if (/\bhtml\b/.test(g)) return "html";
  if (/\b(bulleted|bullet[- ]point|bullet)\s+(list|points?)\b/.test(g)) return "bulleted_list";
  if (
    /\b(as|in|to|a|an|valid|structured)\s+json\b|\bjson\s+(object|array|output|response|format|payload)\b/.test(
      g,
    )
  )
    return "json";
  return null;
}

const MARKDOWN_TABLE_ROW = /\|[^|\n]+\|/;
const MARKDOWN_TABLE_SEP = /\|\s*:?-{3,}/;
const CSV_ROW = /^[^,\n]+(,[^,\n]*)+$/m;
const HTML_TAG = /<\/?[a-z][\s\S]*?>/i;
const BULLET_LINE = /^\s*[-*•]\s+\S/m;

export function outputMatchesFormat(
  format: NamedOutputFormat,
  rendered: string,
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  switch (format) {
    case "markdown_table":
      if (!MARKDOWN_TABLE_ROW.test(rendered)) missing.push("markdown table row (| col | col |)");
      if (!MARKDOWN_TABLE_SEP.test(rendered)) missing.push("markdown separator row (| --- |)");
      break;
    case "csv":
      if (!CSV_ROW.test(rendered)) missing.push("CSV rows (comma-separated values)");
      break;
    case "html":
      if (!HTML_TAG.test(rendered)) missing.push("HTML tags");
      break;
    case "bulleted_list":
      if (!BULLET_LINE.test(rendered)) missing.push("bulleted list lines (- item)");
      break;
    case "json": {
      const trimmed = rendered.trim();
      let parsedObject = false;
      try {
        const v = JSON.parse(trimmed);
        parsedObject = typeof v === "object" && v !== null;
      } catch {
        parsedObject = false;
      }
      if (!parsedObject) missing.push("a JSON object/array (output is not valid JSON)");
      break;
    }
  }
  return { ok: missing.length === 0, missing };
}

function fieldKeyword(phrase: string): string {
  const words = phrase
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words[words.length - 1] ?? "";
}

function splitEnumeration(body: string): string[] {
  return body
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.split(/\s+/).length <= 4);
}

export function findMissingNamedFields(goal: string, rendered: string): string[] {
  if (typeof rendered !== "string" || rendered.trim().length < 12) return [];
  const fields: string[] = [];
  for (const m of goal.matchAll(
    /\b(?:table|columns?|fields?|rows?)\b[^.(]{0,40}?\(([^)]{3,200})\)/gi,
  )) {
    if (m[1]?.includes(",")) fields.push(...splitEnumeration(m[1]));
  }
  for (const m of goal.matchAll(
    /\b(?:columns?|fields?)\b[:\s]+([A-Za-z0-9][A-Za-z0-9 ,&'-]+?)(?=[.;:)]|\s+(?:sorted|ordered|grouped|and one|per |with )|$)/gi,
  )) {
    if (m[1]?.includes(",")) fields.push(...splitEnumeration(m[1]));
  }
  const byKeyword = new Map<string, string>();
  for (const f of fields) {
    const kw = fieldKeyword(f);
    if (kw.length >= 3 && !byKeyword.has(kw)) byKeyword.set(kw, f);
  }
  if (byKeyword.size < 2) return [];
  const hay = rendered.toLowerCase();
  const missing: string[] = [];
  for (const [kw, phrase] of byKeyword) {
    if (!hay.includes(kw)) missing.push(phrase);
  }
  return missing;
}

function forbiddenTokens(goal: string): string[] {
  const out: string[] = [];
  for (const m of goal.matchAll(/\(\s*not\s+([a-z][a-z0-9 -]{2,40}?)\s*\)/gi)) {
    if (m[1]) out.push(m[1]);
  }
  for (const m of goal.matchAll(
    /\bexclud(?:e|ing)\s+([a-z][a-z0-9 -]{2,40}?)(?=[.,;:)]|\s+(?:from|and|but|in|with)\b|$)/gi,
  )) {
    if (m[1]) out.push(m[1]);
  }
  for (const m of goal.matchAll(
    /\bonly\b[^.()]{0,40}?\bnot\s+([a-z][a-z0-9 -]{2,40}?)(?=[.,;:)]|\s+(?:that|which)\b|$)/gi,
  )) {
    if (m[1]) out.push(m[1]);
  }
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of out) {
    const t = raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (t.length >= 4 && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  }
  return tokens;
}

export function findFilterViolations(goal: string, rendered: string): string[] {
  if (typeof rendered !== "string" || rendered.trim().length < 12) return [];
  const tokens = forbiddenTokens(goal);
  if (tokens.length === 0) return [];
  const hay = rendered.toLowerCase();
  const violations: string[] = [];
  for (const tok of tokens) {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(hay)) {
      violations.push(tok);
    }
  }
  return violations;
}
