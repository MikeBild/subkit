// Prose-options-list detector. Mirrors the spirit of the
// STRUCTURED USER INTERACTION skill rule — when the LLM emits a
// numbered options list as prose ("1. Run … 2. Show …" + "Which
// would you prefer?"), the CLI extracts the options and renders a
// real ink ChoicePrompt under the assistant message so the user
// gets an actual structured pick instead of having to type "1" or
// "yes" into free text. Pre-fix sessions dcdcf246 / 86de186b kept
// hitting this anti-pattern despite the skill rules.
//
// The detector is intentionally narrow: it only fires when ALL of
//   - the assistant message ends with a question shape ("Which …?",
//     "Would you …?", "Do you want me to …?", or any equivalent that
//     ends with `?`)
//   - 2+ numbered options ("1. …", "2. …") are present immediately
//     before the question
//   - no pendingElicitation exists (the structured path is already
//     active there — don't double-render)

export interface ProseOption {
  index: number;
  label: string;
  /** Original line text the LLM emitted; preserved as the value so
   *  the engine receives a sentence the LLM can recognise on the
   *  next turn ("Run the existing workflow…"). */
  value: string;
}

export interface DetectedProseOptions {
  options: ProseOption[];
  /** The trailing question line ("Which would you prefer?") that
   *  prompted the choice. Used as the ChoicePrompt's `question`. */
  question: string;
}

const NUMBERED_LINE_RE = /^\s*(\d+)[.)]\s+(.+?)\s*$/;
const QUESTION_TAIL_RE = /\?\s*$/;

// Yes/no question shapes. When the trailing question matches one of
// these, the numbered list above is almost certainly a *description*
// (e.g. "The X workflow: 1. Fetches… 2. Loops… Would you like me to
// run this?") rather than a fork. Pre-fix session 16d6e46a: the
// detector matched a 4-bullet feature description + "Would you like
// me to run this workflow for you now?" and surfaced the bullets as
// a ChoicePrompt — the user picked "Returns a formatted list…" and
// the engine treated that as a free-text prompt. Hard exclusion.
const YES_NO_QUESTION_RE =
  /^(?:would|do|does|did|should|shall|can|could|will|won't|may|might|are|is|was|were|have|has|had|am|don't|doesn't|didn't|shouldn't|won't|isn't|aren't|haven't)\s+/i;

// Pick-style markers — when the trailing question contains one of
// these, we have stronger evidence the list IS a fork. Used as an
// additional positive signal alongside the yes/no exclusion.
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

/**
 * Parse the trailing portion of an assistant message looking for a
 * numbered list followed by a question. Returns null when the
 * shape doesn't match — in that case the CLI falls through to the
 * normal text-input path.
 */
export function detectProseOptions(text: string): DetectedProseOptions | null {
  if (!text || text.length === 0) return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 3) return null;
  // Find the last line that ends with `?` — this is the question.
  let questionIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION_TAIL_RE.test(lines[i] ?? "")) {
      questionIdx = i;
      break;
    }
  }
  if (questionIdx < 1) return null;
  const question = lines[questionIdx] ?? "";
  // Reject yes/no questions outright. A list followed by "Would you
  // like me to…?" is a description, not a fork.
  if (isYesNoQuestion(question)) return null;
  // Require an affirmative pick marker. This narrows from "any
  // question after numbered lines" to "a question that explicitly
  // signals a choice". Keeps real forks ("Which would you prefer?",
  // "Pick one of these options.") and rejects "What does this do?"
  // -style prose questions that happen to follow a numbered list.
  if (!hasPickMarker(question)) return null;
  // Walk backward from the question collecting consecutive numbered
  // lines. The list must be unbroken — a paragraph break between
  // numbered lines disqualifies (the items would not all be
  // siblings of the same fork).
  const options: ProseOption[] = [];
  for (let i = questionIdx - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const m = NUMBERED_LINE_RE.exec(line);
    if (!m) {
      // We've left the numbered list — stop scanning.
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
  // Require at least 2 numbered options — a single bullet isn't a
  // real fork. The numeric indices must form a contiguous 1..N
  // sequence (otherwise we're matching paragraph numbering, not a
  // choice list).
  if (options.length < 2) return null;
  for (let i = 0; i < options.length; i++) {
    if (options[i]?.index !== i + 1) return null;
  }
  return { options, question };
}
