// Filters that reject model-generated next-message suggestions which
// don't look like something a human user would actually type. Ported
// from Claude Code's `shouldFilterSuggestion` (PromptSuggestion service)
// — every rule below has a matching reason tag so suppressed
// suggestions remain auditable in the observability log instead of
// disappearing silently.
//
// The single entry point is `filterSuggestion(text)`:
//   - returns `null` when the suggestion passes all rules
//   - returns the offending `FilterReason` when it should be dropped

export type FilterReason =
  | "empty"
  | "done"
  | "meta_text"
  | "meta_wrapped"
  | "error_message"
  | "prefixed_label"
  | "too_few_words"
  | "too_many_words"
  | "too_long"
  | "multiple_sentences"
  | "has_formatting"
  | "evaluative"
  | "claude_voice"
  | "unknown_catalog";

// The resource catalogs `sk` can actually enumerate. The suggestion
// model, after a run of "list my X / list my Y", tends to extrapolate a
// plausible-sounding next catalog that does not exist ("list my agents",
// "list my pipelines"). A bare "list/show my <noun>" suggestion is only
// valid when <noun> names a real catalog — otherwise we'd lead the user
// straight into a "subkit has no such thing" reply.
const CATALOG_NOUN_RE =
  /\b(workflows?|connectors?|executions?|runs?|schedules?|skills?|knowledge|knowledges?|wissensquellen|credentials?|patch[\s-]?candidates?|api[\s-]?keys?|roles?|users?|tenants?|knowledge[\s-]?sources?)\b/i;

// "(list|show|display|view|get) (my|all|the|our) …" — the bare
// enumerate-a-resource shape. Free-form suggestions ("run the tests",
// "commit this") never match this and pass through untouched.
const ENUMERATE_RESOURCE_RE = /^(?:list|show|display|view|get)\s+(?:my|all|the|our)\b/i;

const ALLOWED_SINGLE_WORDS = new Set<string>([
  // Affirmatives
  "yes",
  "yeah",
  "yep",
  "yea",
  "yup",
  "sure",
  "ok",
  "okay",
  // Actions
  "push",
  "commit",
  "deploy",
  "stop",
  "continue",
  "check",
  "exit",
  "quit",
  "save",
  "run",
  "ship",
  // Negation
  "no",
]);

export function filterSuggestion(suggestion: string | null | undefined): FilterReason | null {
  if (suggestion == null || suggestion.trim().length === 0) return "empty";

  const trimmed = suggestion.trim();
  const lower = trimmed.toLowerCase();
  const wordCount = trimmed.split(/\s+/).length;

  if (lower === "done") return "done";

  // Meta-text: the model literally said "no suggestion" / "stay silent".
  if (
    lower === "nothing found" ||
    lower === "nothing found." ||
    lower.startsWith("nothing to suggest") ||
    lower.startsWith("no suggestion") ||
    /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
    /^\W*silence\W*$/.test(lower)
  ) {
    return "meta_text";
  }

  // Wrapped meta-reasoning: "(silence — nothing obvious)" / "[no suggestion]".
  if (/^\(.*\)$/.test(trimmed) || /^\[.*\]$/.test(trimmed)) return "meta_wrapped";

  // Surfaced provider error strings — never echo these as a suggestion.
  if (
    lower.startsWith("api error:") ||
    lower.startsWith("prompt is too long") ||
    lower.startsWith("request timed out") ||
    lower.startsWith("invalid api key") ||
    lower.startsWith("image was too large")
  ) {
    return "error_message";
  }

  // Prefixed label like "Suggestion: run the tests" — the model is
  // labeling its output instead of just emitting the suggestion.
  if (/^\w+:\s/.test(trimmed)) return "prefixed_label";

  // "list my agents" / "show my pipelines" — an enumerate-a-resource
  // suggestion whose noun is not a catalog sk actually has. Drop it so
  // the predictor never leads the user into a dead-end concept.
  if (ENUMERATE_RESOURCE_RE.test(trimmed) && !CATALOG_NOUN_RE.test(trimmed)) {
    return "unknown_catalog";
  }

  if (wordCount < 2) {
    if (trimmed.startsWith("/")) {
      // Slash commands are first-class user input.
    } else if (!ALLOWED_SINGLE_WORDS.has(lower)) {
      return "too_few_words";
    }
  }

  if (wordCount > 12) return "too_many_words";
  if (trimmed.length >= 100) return "too_long";

  // Multiple sentences: "Run the tests. Then push." — pick one or none.
  if (/[.!?]\s+[A-Z]/.test(trimmed)) return "multiple_sentences";

  // Formatting: newlines, bullets, bold — assistant-voice tells.
  if (/[\n*]|\*\*/.test(trimmed)) return "has_formatting";

  // Evaluative phrasing — users don't praise the assistant in a follow-up
  // they want executed; this is the model offering its own commentary.
  if (
    /thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(
      lower,
    )
  ) {
    return "evaluative";
  }

  // Assistant-voice openers — the model started narrating as itself
  // instead of predicting the user's next message.
  if (
    /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(
      trimmed,
    )
  ) {
    return "claude_voice";
  }

  return null;
}
