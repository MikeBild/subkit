type FilterReason =
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

const CATALOG_NOUN_RE =
  /\b(workflows?|connectors?|executions?|runs?|schedules?|skills?|knowledge|knowledges?|wissensquellen|credentials?|patch[\s-]?candidates?|api[\s-]?keys?|roles?|users?|tenants?|knowledge[\s-]?sources?)\b/i;

const ENUMERATE_RESOURCE_RE = /^(?:list|show|display|view|get)\s+(?:my|all|the|our)\b/i;

const ALLOWED_SINGLE_WORDS = new Set<string>([
  "yes",
  "yeah",
  "yep",
  "yea",
  "yup",
  "sure",
  "ok",
  "okay",
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
  "no",
]);

export function filterSuggestion(suggestion: string | null | undefined): FilterReason | null {
  if (suggestion == null || suggestion.trim().length === 0) return "empty";

  const trimmed = suggestion.trim();
  const lower = trimmed.toLowerCase();
  const wordCount = trimmed.split(/\s+/).length;

  if (lower === "done") return "done";

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

  if (/^\(.*\)$/.test(trimmed) || /^\[.*\]$/.test(trimmed)) return "meta_wrapped";

  if (
    lower.startsWith("api error:") ||
    lower.startsWith("prompt is too long") ||
    lower.startsWith("request timed out") ||
    lower.startsWith("invalid api key") ||
    lower.startsWith("image was too large")
  ) {
    return "error_message";
  }

  if (/^\w+:\s/.test(trimmed)) return "prefixed_label";

  if (ENUMERATE_RESOURCE_RE.test(trimmed) && !CATALOG_NOUN_RE.test(trimmed)) {
    return "unknown_catalog";
  }

  if (wordCount < 2) {
    if (trimmed.startsWith("/")) {
    } else if (!ALLOWED_SINGLE_WORDS.has(lower)) {
      return "too_few_words";
    }
  }

  if (wordCount > 12) return "too_many_words";
  if (trimmed.length >= 100) return "too_long";

  if (/[.!?]\s+[A-Z]/.test(trimmed)) return "multiple_sentences";

  if (/[\n*]|\*\*/.test(trimmed)) return "has_formatting";

  if (
    /thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(
      lower,
    )
  ) {
    return "evaluative";
  }

  if (
    /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(
      trimmed,
    )
  ) {
    return "claude_voice";
  }

  return null;
}
