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

/**
 * Focused per-format generation guidance — the "small output-format skill"
 * content, inlined into always-present generation grounding. (The single-shot
 * author_workflow generate flow renders skills only as the one-line INDEX;
 * full skill BODIES render solely for `loaded_skill_slugs`, which is empty
 * there — no tool loop loads any — so a skill body never reaches generation.)
 * Returned only when the goal names a format. Each block tells the
 * model to render that format as the FINAL workflow output (the
 * output_transform / last step result the caller receives), with a concrete
 * shape — not in an intermediate step that a later transform discards.
 */
export function formatGuidance(format: NamedOutputFormat): string {
  switch (format) {
    case "markdown_table":
      return [
        "The goal asks for a MARKDOWN TABLE. The workflow's FINAL output (the",
        "`output_transform_function`, or the last transform whose result is the",
        "output) MUST be a STRING containing: a header row, a `| --- |`",
        "separator row, then one `| … |` row per record. Do NOT return the rows",
        "as a JSON array and do NOT leave the markdown in an intermediate step",
        "that a later transform replaces — the caller receives the final output.",
        "Render it in JS by joining, with newlines, the header line, the",
        "separator line, then one piped line per row.",
      ].join(" ");
    case "csv":
      return [
        "The goal asks for CSV. The FINAL output MUST be a STRING: a header line",
        "of comma-separated column names, then one comma-separated line per",
        "record (escape values containing commas/quotes). Not a JSON array.",
      ].join(" ");
    case "html":
      return [
        "The goal asks for HTML. The FINAL output MUST be a STRING of HTML",
        "markup (real tags: `<table>`/`<tr>`/`<td>`, `<ul>`/`<li>`, etc.) — the",
        "actual rendered markup the caller will display, not structured data.",
      ].join(" ");
    case "bulleted_list":
      return [
        "The goal asks for a BULLETED LIST. The FINAL output MUST be a STRING",
        "with one `- ` prefixed line per item (`items.map(i => '- ' + i).join('\\n')`),",
        "not a JSON array.",
      ].join(" ");
    case "json":
      return [
        "The goal asks for JSON. Declare a minimal `output_schema` for exactly",
        "the fields requested and return a structured object/array matching it",
        "(the engine serialises it) — do NOT hand-render JSON as a string.",
      ].join(" ");
  }
}

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
