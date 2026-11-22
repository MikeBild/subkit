export interface OpenQuestion {
  readonly tool_name: string;
  readonly input?: unknown;
}

export type QuestionClass = "typed" | "button_only" | "secret";

export type TypedReply =
  | { readonly kind: "answer"; readonly output: Readonly<Record<string, unknown>> }
  | { readonly kind: "message" }
  | { readonly kind: "refused" };

const MESSAGE: TypedReply = { kind: "message" };
const REFUSED: TypedReply = { kind: "refused" };

const AUTHORITY_KEYS = [
  "commit_intent",
  "approval_handle",
  "approval_url",
  "authorization_url",
  "effect",
  "target",
  "bound_action",
  "device",
  "diff",
  "diffs",
];

const PLAIN_CONFIRM_KEYS = new Set(["question", "summary", "kind", "default", "playbook_step_id"]);

const YES = new Set([
  "ja",
  "jo",
  "jep",
  "klar",
  "ok",
  "okay",
  "yes",
  "y",
  "yep",
  "sure",
  "mach",
  "mach das",
  "erlauben",
  "einmal erlauben",
  "allow",
  "allow once",
  "go",
  "do it",
]);

const NO = new Set([
  "nein",
  "ne",
  "nee",
  "nö",
  "no",
  "n",
  "nope",
  "ablehnen",
  "abbrechen",
  "stopp",
  "stop",
  "decline",
  "cancel",
  "lieber nicht",
]);

function normalized(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase("de")
    .replace(/[.!?,;:\s]+$/u, "")
    .replace(/\s+/gu, " ");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function typedYesNo(text: string): boolean | null {
  const word = normalized(text);
  if (!word || word.length > 20) return null;
  if (YES.has(word)) return true;
  if (NO.has(word)) return false;
  return null;
}

function choiceValue(input: unknown, text: string): string | null {
  const options = record(input)?.options;
  if (!Array.isArray(options)) return null;
  const typed = normalized(text);
  if (!typed) return null;
  const matched = new Set<string>();
  for (const option of options) {
    const entry = record(option);
    if (!entry || typeof entry.value !== "string") continue;
    const names = [entry.value, typeof entry.label === "string" ? entry.label : null];
    if (names.some((name) => name !== null && normalized(name) === typed)) matched.add(entry.value);
  }
  const [only] = matched;
  return matched.size === 1 && only !== undefined ? only : null;
}

function singleFieldName(input: unknown): string | null {
  const fields = record(input)?.fields;
  if (!Array.isArray(fields) || fields.length !== 1) return null;
  const name = record(fields[0])?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function grantsAuthority(input: Record<string, unknown>): boolean {
  return AUTHORITY_KEYS.some((key) => input[key] !== undefined && input[key] !== null);
}

function plainConfirmation(input: Record<string, unknown>): boolean {
  const kind = input.kind ?? "generic";
  return (
    kind === "generic" &&
    input.destructive !== true &&
    Object.keys(input).every((key) => PLAIN_CONFIRM_KEYS.has(key))
  );
}

function asksForSecret(input: Record<string, unknown>): boolean {
  const fields = Array.isArray(input.fields) ? input.fields : [];
  return fields.some((field) => {
    const entry = record(field);
    return entry !== null && (entry.type === "password" || entry.sensitive === true);
  });
}

export function questionClass(question: OpenQuestion): QuestionClass {
  const input = record(question.input) ?? {};
  if (question.tool_name === "ask_user_form" && asksForSecret(input)) return "secret";
  if (grantsAuthority(input)) return "button_only";
  if (question.tool_name === "ask_user_confirm" && !plainConfirmation(input)) return "button_only";
  return "typed";
}

export function typedReply(question: OpenQuestion, text: string): TypedReply {
  const kind = questionClass(question);
  if (kind === "secret") return REFUSED;
  if (kind === "button_only" || !text.trim()) return MESSAGE;
  switch (question.tool_name) {
    case "ask_user_text":
      return { kind: "answer", output: { text } };
    case "ask_user_confirm": {
      const confirmed = typedYesNo(text);
      return confirmed === null ? MESSAGE : { kind: "answer", output: { confirmed } };
    }
    case "ask_user_choice": {
      const value = choiceValue(question.input, text);
      return value === null ? MESSAGE : { kind: "answer", output: { value } };
    }
    case "ask_user_form": {
      const name = singleFieldName(question.input);
      return name === null ? MESSAGE : { kind: "answer", output: { [name]: text } };
    }
    default:
      return MESSAGE;
  }
}
