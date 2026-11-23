import { normalizeForQuote, occursBounded } from "@shared/quote-text.ts";
import type { ActionVerb } from "@shared/request-words.ts";
import type { BoundAction } from "../../instruction-cover/bound-action.ts";
import { type RuleScope, ruleEligible, scopeOf } from "./rule-scope.ts";

const STANDING_WORDS: readonly string[] = [
  "always",
  "every time",
  "each time",
  "from now on",
  "in future",
  "in the future",
  "going forward",
  "without asking",
  "without confirmation",
  "no need to ask",
  "dont ask",
  'don"t ask',
  "do not ask",
  "stop asking",
  "immer",
  "jedes mal",
  "ab jetzt",
  "ab sofort",
  "kunftig",
  "in zukunft",
  "ohne zu fragen",
  "ohne nachfrage",
  "ohne ruckfrage",
  "nicht mehr fragen",
  "nicht fragen",
];

const WITHHELD_WORDS: readonly string[] = [
  "never",
  "always ask",
  "ask me",
  "ask first",
  "ask before",
  "not without asking",
  "only once",
  "just this once",
  "this time only",
  "nie",
  "niemals",
  "immer fragen",
  "immer erst fragen",
  "frag mich",
  "frage mich",
  "erst fragen",
  "vorher fragen",
  "nicht ohne zu fragen",
  "nur dieses mal",
  "nur einmal",
];

const VERB_STEMS: Readonly<Record<ActionVerb, readonly string[]>> = {
  send: [
    "send",
    "sent",
    "mail",
    "email",
    "message",
    "post",
    "notify",
    "reply",
    "forward",
    "sende",
    "schick",
    "verschick",
    "antwort",
    "weiterleit",
    "benachrichtig",
    "nachricht",
  ],
  create: ["create", "add", "open", "file", "log", "new", "erstell", "anleg", "leg", "eroffne"],
  update: [
    "update",
    "change",
    "edit",
    "set",
    "mark",
    "move",
    "assign",
    "close",
    "aktualisier",
    "ander",
    "bearbeit",
    "setz",
    "markier",
    "verschieb",
    "weise",
    "schliess",
  ],
  run: ["run", "start", "trigger", "execute", "starte", "fuhr", "ausfuhr", "lass"],
  save: ["save", "store", "keep", "speicher", "sicher", "ableg"],
  other: [],
};

function words(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}@._+-]+/u).filter((word) => word.length > 0);
}

function says(normalized: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => occursBounded(phrase, normalized));
}

function namesVerb(normalized: string, verbs: readonly ActionVerb[]): boolean {
  const spoken = words(normalized);
  return verbs.some((verb) =>
    VERB_STEMS[verb].some((stem) => spoken.some((word) => word.startsWith(stem))),
  );
}

function namesRecipient(normalized: string, recipient: string): boolean {
  const wanted = normalizeForQuote(recipient);
  if (wanted.length === 0) return false;
  if (!/[@._+-]/u.test(wanted)) return occursBounded(wanted, normalized);
  return words(normalized).some((word) => word.replace(/[.,;:!?]+$/u, "") === wanted);
}

export function ruleFromWords(spoken: string, action: BoundAction): RuleScope | null {
  if (!ruleEligible(action)) return null;
  const normalized = normalizeForQuote(spoken);
  if (!says(normalized, STANDING_WORDS) || says(normalized, WITHHELD_WORDS)) return null;
  if (!namesVerb(normalized, [action.verb, ...action.verbs])) return null;
  const named = action.recipients.every((recipient) => namesRecipient(normalized, recipient));
  return named ? scopeOf(action) : null;
}
