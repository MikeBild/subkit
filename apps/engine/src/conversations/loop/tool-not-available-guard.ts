// Detect when the LLM denies a tool that IS in the resolved palette.
//
// Background — Root D in the 2026-05-16 forensics. When the schema
// repair loop failed (root B), the model occasionally responded with
// prose like "the tools to create or update schedules
// (create_schedule, update_schedule) are not available in this
// conversation interface" — although both tools were in
// `ALWAYS_AVAILABLE_CLEANUP` (apps/engine/src/conversations/tools/
// authoring-palette.ts:84-98). The seed skill (Phase 2 fix) now
// instructs the LLM never to claim a tool is unavailable without
// quoting the structured envelope; this guard is defence-in-depth
// that surfaces the regression to observability if it ever recurs.
//
// The guard is intentionally narrow:
//
//   - Only matches tokens that look like tool names (snake_case,
//     `[a-z][a-z0-9_]*`, length ≥ 4). Generic phrases like "the
//     result is not available yet" never match because "result" is
//     not in the palette and is not the subject of an availability
//     claim about a tool.
//
//   - Only fires when the *denied* token IS in the resolved palette.
//     If the model legitimately reports a missing capability ("the
//     `send_carrier_pigeon` tool does not exist") the guard stays
//     quiet — that's the correct outcome of `cannot_help`.
//
//   - One match per turn. A model that lists three tools as
//     unavailable would otherwise spam the counter; collapsing to
//     the first match keeps the signal aligned with the underlying
//     turn-level decision.

/** Negation phrases that pair with a tool-name token to make a claim
 *  of unavailability. Matched independently of the tool token; the
 *  detector then looks for a palette token in a window around the
 *  matched phrase. */
const NEGATION_PHRASES: ReadonlyArray<RegExp> = [
  /\b(?:is|are)\s+not\s+available\b/i,
  /\b(?:is|are)\s+not\s+(?:in|part\s+of)\s+(?:my|the|this|your)\s+(?:palette|toolset|available\s+tools?)\b/i,
  /\bI\s+(?:do\s+not|don['’]?t)\s+have\s+(?:access\s+to|the\s+ability\s+to\s+call)\b/i,
  /\bno\s+(?:such\s+)?(?:tool|tools)\s+(?:called\s+)?(?:are|is)?\s*available\b/i,
];

/** Tool-name token: snake_case, length ≥ 4 to avoid generic word matches. */
const TOOL_TOKEN = /\b([a-z][a-z0-9_]{3,})\b/g;

/** How far around a negation match to search for the tool token.
 *  ±200 chars covers paren-list forms like "(create_schedule,
 *  update_schedule) are not available" while staying tight enough
 *  that two unrelated sentences cannot bleed into each other. */
const WINDOW = 200;

export interface ToolHallucinatedAbsenceVerdict {
  hallucinated: boolean;
  toolName: string | null;
  /** Which negation phrase fired — useful when triaging false positives. */
  pattern: number | null;
}

export interface ToolHallucinatedAbsenceInput {
  assistantText: string;
  /** Set of tool names actually exposed to the LLM this turn. */
  palette: ReadonlySet<string>;
}

export function detectToolHallucinatedAbsence(
  input: ToolHallucinatedAbsenceInput,
): ToolHallucinatedAbsenceVerdict {
  const text = input.assistantText;
  if (!text || input.palette.size === 0) {
    return { hallucinated: false, toolName: null, pattern: null };
  }
  for (let i = 0; i < NEGATION_PHRASES.length; i += 1) {
    const re = NEGATION_PHRASES[i]!;
    const m = re.exec(text);
    if (!m) continue;
    const phraseStart = m.index;
    const phraseEnd = phraseStart + m[0].length;
    const winStart = Math.max(0, phraseStart - WINDOW);
    const winEnd = Math.min(text.length, phraseEnd + WINDOW);
    const window = text.slice(winStart, winEnd);
    // Reset state on the shared regex.
    TOOL_TOKEN.lastIndex = 0;
    let tok: RegExpExecArray | null = TOOL_TOKEN.exec(window);
    while (tok !== null) {
      const candidate = tok[1];
      if (candidate) {
        const normalized = candidate.toLowerCase();
        if (input.palette.has(normalized)) {
          return { hallucinated: true, toolName: normalized, pattern: i };
        }
      }
      tok = TOOL_TOKEN.exec(window);
    }
  }
  return { hallucinated: false, toolName: null, pattern: null };
}
