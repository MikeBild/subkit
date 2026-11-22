interface ProseOption {
  index: number;
  label: string;
  value: string;
}

interface DetectedProseOptions {
  options: ProseOption[];
  question: string;
}

const NUMBERED_LINE_RE = /^\s*(\d+)[.)]\s+(.+?)\s*$/;
const QUESTION_TAIL_RE = /\?\s*$/;

const YES_NO_QUESTION_RE =
  /^(?:would|do|does|did|should|shall|can|could|will|won't|may|might|are|is|was|were|have|has|had|am|don't|doesn't|didn't|shouldn't|won't|isn't|aren't|haven't)\s+/i;

const PICK_MARKERS = [
  "which",
  "prefer",
  "choose",
  "pick",
  "select",
  "option",
  "either",
  "or both",
  "what would",
  "what do you want",
] as const;

function isYesNoQuestion(question: string): boolean {
  return YES_NO_QUESTION_RE.test(question.trim());
}

function hasPickMarker(question: string): boolean {
  const lower = question.toLowerCase();
  return PICK_MARKERS.some((m) => lower.includes(m));
}

export function detectProseOptions(text: string): DetectedProseOptions | null {
  if (!text || text.length === 0) return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 3) return null;
  let questionIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION_TAIL_RE.test(lines[i] ?? "")) {
      questionIdx = i;
      break;
    }
  }
  if (questionIdx < 1) return null;
  const question = lines[questionIdx] ?? "";
  if (isYesNoQuestion(question)) return null;
  if (!hasPickMarker(question)) return null;
  const options: ProseOption[] = [];
  for (let i = questionIdx - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const m = NUMBERED_LINE_RE.exec(line);
    if (!m) {
      break;
    }
    const idx = Number.parseInt(m[1] ?? "", 10);
    const label = (m[2] ?? "").replace(/,?\s*or\s*$/i, "").trim();
    if (Number.isFinite(idx) && label.length > 0) {
      options.unshift({
        index: idx,
        label,
        value: label,
      });
    }
  }
  if (options.length < 2) return null;
  for (let i = 0; i < options.length; i++) {
    if (options[i]?.index !== i + 1) return null;
  }
  return { options, question };
}
