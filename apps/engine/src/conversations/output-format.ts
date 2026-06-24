// Goal-named output-format fidelity.
//
// When a user's goal NAMES a concrete output format — "a markdown table",
// "CSV", "an HTML body", "a bulleted list" — that format is a hard output
// contract, not a stylistic preference. Correct data returned as a JSON
// array does NOT satisfy "return a markdown table".
//
// Two pure, deterministic helpers (no LLM, no I/O, fully unit-testable),
// shared by:
//   * the generation grounding (`authoring-pipeline.ts`) — to log/ground when
//     a goal names a format, AND
//   * the format-aware preview judge (`preview-judge.ts`) — to downgrade a
//     would-be `passes` when the rendered output is not actually that format.
//
// Naming-gated by design: detection keys on the user's OWN words, never an
// inferred intent, so a plain-data goal triggers nothing (no false blocks).

export type NamedOutputFormat = "markdown_table" | "csv" | "html" | "bulleted_list" | "json";

/**
 * Detect a concrete output format EXPLICITLY named in the goal. Returns
 * `null` when the goal names none — callers then do nothing. This is
 * deliberately a literal-phrase match on the user's wording (e.g. "markdown
 * table"), not a heuristic that infers format from the shape of the request.
 */
export function detectNamedOutputFormat(goal: string): NamedOutputFormat | null {
  const g = goal.toLowerCase();
  if (/\b(markdown|md)\s+table\b/.test(g)) return "markdown_table";
  if (/\bcsv\b/.test(g)) return "csv";
  if (/\bhtml\b/.test(g)) return "html";
  if (/\b(bulleted|bullet[- ]point|bullet)\s+(list|points?)\b/.test(g)) return "bulleted_list";
  // JSON is gated to output-intent phrasings ("as json", "a json object",
  // "json output") so an incidental mention ("the API returns json") does not
  // trigger it.
  if (
    /\b(as|in|to|a|an|valid|structured)\s+json\b|\bjson\s+(object|array|output|response|format|payload)\b/.test(
      g,
    )
  )
    return "json";
  return null;
}

// (A per-format generation-guidance helper `formatGuidance` lived here. It was
// rolled back after a local A/B showed it did not improve output-format
// fidelity over the one-line design rule + the final-output surfacing fix — the
// model already renders the named format. The detector + matcher below remain:
// they power the FORMAT-AWARE PREVIEW JUDGE, which is the verified lever.)

// Markdown signatures are kept BYTE-IDENTICAL to the live benchmark's content
// checks (apps/engine/eval/live-report.ts) so the format contract is
// single-sourced: what the judge enforces is exactly what the benchmark
// measures.
const MARKDOWN_TABLE_ROW = /\|[^|\n]+\|/;
const MARKDOWN_TABLE_SEP = /\|\s*:?-{3,}/;
const CSV_ROW = /^[^,\n]+(,[^,\n]*)+$/m;
const HTML_TAG = /<\/?[a-z][\s\S]*?>/i;
const BULLET_LINE = /^\s*[-*•]\s+\S/m;

/**
 * Does `rendered` carry the structural signature of `format`? Returns
 * concrete `missing` reasons on a miss (surfaced to the user/repair loop).
 * `rendered` is the final output the caller sees, coerced to a string by the
 * caller — a structured (JSON) output correctly fails the format checks.
 */
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
      // A structured output is already JSON once serialised; the only miss is
      // a non-JSON string (e.g. a markdown table where JSON was asked for).
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

// ---------------------------------------------------------------------------
// Named-field completeness — deterministic guard for the preview judge.
//
// The LLM judge is unreliable about a table/object being COMPLETE: it passed
// outputs missing columns the goal explicitly listed. This is the hard,
// unit-testable guard for the subset that is robustly detectable: a goal that
// EXPLICITLY ENUMERATES the fields — either parenthesized after the structure
// noun, `… table (A, B, C, D) …`, or introduced by a `columns`/`fields`
// keyword, `… with columns A, B, C and D …`. Inline lists without those signals
// (`a table with A, B, C`) are NOT parsed — they're left to the LLM, so a
// plain-data or empty-result goal is never falsely downgraded.
// ---------------------------------------------------------------------------

/** Last distinctive word of a field phrase ("GitHub stars" → "stars",
 *  "recent-error count" → "count"). Lowercased; punctuation stripped. */
function fieldKeyword(phrase: string): string {
  const words = phrase
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words[words.length - 1] ?? "";
}

/** Split an enumeration body ("A, B, C and D") into trimmed short field
 *  phrases. Rejects items longer than 4 words (those are sentences, not
 *  field names). */
function splitEnumeration(body: string): string[] {
  return body
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.split(/\s+/).length <= 4);
}

/**
 * Returns the field names a goal EXPLICITLY enumerates that are ABSENT from the
 * rendered output. Empty when the goal carries no explicit enumeration, when the
 * output is empty/trivial (an empty result set is not "incomplete"), or when
 * every enumerated field is present. Pure + deterministic.
 */
export function findMissingNamedFields(goal: string, rendered: string): string[] {
  if (typeof rendered !== "string" || rendered.trim().length < 12) return [];
  const fields: string[] = [];
  // (a) Parenthesized list following a structure noun: `table (A, B, C, D)`.
  for (const m of goal.matchAll(
    /\b(?:table|columns?|fields?|rows?)\b[^.(]{0,40}?\(([^)]{3,200})\)/gi,
  )) {
    if (m[1]?.includes(",")) fields.push(...splitEnumeration(m[1]));
  }
  // (b) `columns`/`fields` keyword introducing a comma/and list, up to a
  //     sentence/clause boundary.
  for (const m of goal.matchAll(
    /\b(?:columns?|fields?)\b[:\s]+([A-Za-z0-9][A-Za-z0-9 ,&'-]+?)(?=[.;:)]|\s+(?:sorted|ordered|grouped|and one|per |with )|$)/gi,
  )) {
    if (m[1]?.includes(",")) fields.push(...splitEnumeration(m[1]));
  }
  // Dedup by keyword; need a real enumeration (>= 2 fields) to act.
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

// ---------------------------------------------------------------------------
// Filter violations — deterministic guard for the preview judge.
//
// The LLM judge is unreliable about EXCLUSION: it passed outputs whose rows
// visibly contain a value the goal explicitly excludes (goal "OFFLINE (not
// connected) chargers only", output rows showing "connected"). This is the
// hard, unit-testable guard for the subset that is robustly detectable: a goal
// that EXPLICITLY names a forbidden value — parenthesized `(not X)`, an
// `exclude X` clause, or an `only … not Z` contrast. Bare prose negations
// ("do not include …") are NOT parsed — they're left to the LLM, so a
// plain-data goal is never falsely downgraded. Domain-neutral by construction:
// the forbidden token comes from the user's OWN words, not an inferred list.
// ---------------------------------------------------------------------------

/** Forbidden tokens a goal EXPLICITLY excludes (parenthesized `(not X)`,
 *  `exclude X`, or `only … not Z`). Lowercased, ≥4 chars, deduped. */
function forbiddenTokens(goal: string): string[] {
  const out: string[] = [];
  // (a) parenthesized negation: "(not connected)".
  for (const m of goal.matchAll(/\(\s*not\s+([a-z][a-z0-9 -]{2,40}?)\s*\)/gi)) {
    if (m[1]) out.push(m[1]);
  }
  // (b) "exclude X" / "excluding X" up to a clause boundary.
  for (const m of goal.matchAll(
    /\bexclud(?:e|ing)\s+([a-z][a-z0-9 -]{2,40}?)(?=[.,;:)]|\s+(?:from|and|but|in|with)\b|$)/gi,
  )) {
    if (m[1]) out.push(m[1]);
  }
  // (c) explicit contrast: "only X, not Z" / "only X and not Z".
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

/**
 * Returns the goal-forbidden tokens that nonetheless APPEAR (as whole words)
 * in the rendered output — a visible filter violation. Empty when the goal
 * names no explicit exclusion, when the output is empty/trivial, or when no
 * forbidden token is present. Pure + deterministic. The whole-word check
 * avoids incidental substrings ("connected" never matches "disconnected").
 */
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
