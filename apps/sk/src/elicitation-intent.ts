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

const ASSISTANT_CONFIRM_REQUEST_RE =
  /\b(reply|type|say|answer|respond|confirm)\s+(?:with\s+)?["'`]?(yes|y|ok|okay|confirm|approve|save|proceed|do\s+it|go\s+ahead)["'`]?/i;
export function looksLikeAssistantConfirmRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return ASSISTANT_CONFIRM_REQUEST_RE.test(text);
}
