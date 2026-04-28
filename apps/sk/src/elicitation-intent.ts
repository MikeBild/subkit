// Classify free-text user input as an elicitation answer (confirm / reject /
// pick) or a non-answer.
//
// The CLI uses this to decide whether the user typed an answer to an open
// `askUser.*` elicitation or whether they meant to start a new conversational
// turn. Used by both the ink TUI (`ink-app.tsx`) and the headless REPL
// (`repl.ts`).
//
// Design rules:
//   - Allow common compound affirmatives ("save it", "go ahead", "do it").
//   - Allow compound rejections ("no thanks", "never mind").
//   - Allow option picks: "1", "option 2", "yes for option 2".
//   - Never claim intent for ambiguous text ("tell me more", "what about X").
//
// Failing safe is the goal: if intent isn't unambiguous, return
// `{ kind: "ambiguous" }` so the caller can show a hint instead of
// guessing.

export type ElicitationIntent =
  | { kind: "confirm" }
  | { kind: "reject" }
  | { kind: "pick"; optionIndex: number }
  | { kind: "ambiguous" };

const STRIP_TRAILING = /[.!?\s]+$/;

const CONFIRM_RE =
  /^(?:yes(?: please)?|y|yep|yeah|yup|sure|of course|absolutely|ok(?:ay)?|fine|approve(?:d)?|confirm(?:ed)?|go(?: ahead)?(?: and (?:save|do) it)?|do it|save(?: it)?|please(?: save)?|commit(?: it)?|ship(?: it)?|looks good|lgtm|sounds good|sounds great)$/i;

const REJECT_RE =
  /^(?:no(?: thanks?)?|n|nope|nah|cancel|abort|reject(?:ed)?|stop|don'?t|never mind|nevermind|hold on|wait)$/i;

const OPTION_RE = /^(?:yes for )?option\s*(\d+)$/i;
const BARE_NUMBER_RE = /^(\d+)$/;
const PICK_PHRASE_RE = /^(?:pick|choose|select)\s*(?:option\s*)?(\d+)$/i;

export function classifyElicitationIntent(rawText: string): ElicitationIntent {
  const text = rawText.trim().replace(STRIP_TRAILING, "").toLowerCase();
  if (text.length === 0) return { kind: "ambiguous" };

  if (CONFIRM_RE.test(text)) return { kind: "confirm" };
  if (REJECT_RE.test(text)) return { kind: "reject" };

  const optMatch = OPTION_RE.exec(text) ?? PICK_PHRASE_RE.exec(text);
  if (optMatch?.[1]) {
    const idx = Number.parseInt(optMatch[1], 10);
    if (Number.isFinite(idx) && idx >= 1) return { kind: "pick", optionIndex: idx };
  }
  const numMatch = BARE_NUMBER_RE.exec(text);
  if (numMatch?.[1]) {
    const idx = Number.parseInt(numMatch[1], 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= 99) {
      return { kind: "pick", optionIndex: idx };
    }
  }

  return { kind: "ambiguous" };
}
