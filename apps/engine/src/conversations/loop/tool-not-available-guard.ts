const NEGATION_PHRASES: ReadonlyArray<RegExp> = [
  /\b(?:is|are)\s+not\s+available\b/i,
  /\b(?:is|are)\s+not\s+(?:in|part\s+of)\s+(?:my|the|this|your)\s+(?:palette|toolset|available\s+tools?)\b/i,
  /\bI\s+(?:do\s+not|don['’]?t)\s+have\s+(?:access\s+to|the\s+ability\s+to\s+call)\b/i,
  /\bno\s+(?:such\s+)?(?:tool|tools)\s+(?:called\s+)?(?:are|is)?\s*available\b/i,
];

const TOOL_TOKEN = /\b([a-z][a-z0-9_]{3,})\b/g;

const WINDOW = 200;

export interface ToolHallucinatedAbsenceVerdict {
  hallucinated: boolean;
  toolName: string | null;
  pattern: number | null;
}

export interface ToolHallucinatedAbsenceInput {
  assistantText: string;
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
