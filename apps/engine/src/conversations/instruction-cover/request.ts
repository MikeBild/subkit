import type { ActionVerb } from "./bound-action.ts";

type RequestVerb = Exclude<ActionVerb, "other">;

interface VerbForms {
  readonly plain: readonly string[];
  readonly positional: readonly string[];
}

const VERB_FORMS: Readonly<Record<RequestVerb, VerbForms>> = {
  send: {
    plain: [
      "send",
      "sende",
      "senden",
      "schick",
      "schicke",
      "schicken",
      "verschick",
      "verschicke",
      "verschicken",
      "abschicken",
      "absenden",
      "maile",
      "mailen",
      "schreib",
      "schreibe",
      "schreiben",
      "write",
      "leite",
      "weiterleiten",
      "antworte",
      "antworten",
      "poste",
      "posten",
      "notify",
      "benachrichtige",
      "benachrichtigen",
      "informiere",
      "informieren",
      "tell",
      "sag",
      "sage",
      "kommentiere",
      "kommentieren",
    ],
    positional: [
      "mail",
      "email",
      "message",
      "text",
      "post",
      "comment",
      "reply",
      "forward",
      "respond",
      "ping",
    ],
  },
  create: {
    plain: [
      "create",
      "erstelle",
      "erstell",
      "erstellen",
      "anlegen",
      "lege",
      "leg",
      "add",
      "fuge",
      "hinzufugen",
      "buche",
      "buchen",
      "plane",
      "planen",
      "trag",
      "trage",
      "eintragen",
      "eroffne",
      "eroffnen",
      "erfasse",
      "erfassen",
      "notiere",
      "notieren",
      "reiche",
      "einreichen",
      "submit",
      "entwirf",
      "entwerfe",
    ],
    positional: [
      "book",
      "schedule",
      "open",
      "make",
      "mach",
      "mache",
      "log",
      "file",
      "record",
      "draft",
    ],
  },
  update: {
    plain: [
      "aktualisiere",
      "aktualisieren",
      "andere",
      "andern",
      "setze",
      "setzen",
      "markiere",
      "markieren",
      "verschiebe",
      "verschieben",
      "rename",
      "benenne",
      "umbenennen",
      "bearbeite",
      "bearbeiten",
      "assign",
      "weise",
      "zuweisen",
      "schliesse",
      "schliessen",
      "erledige",
      "reschedule",
      "verlege",
      "verlegen",
      "korrigiere",
      "korrigieren",
      "ersetze",
      "ersetzen",
    ],
    positional: [
      "update",
      "change",
      "set",
      "mark",
      "move",
      "edit",
      "close",
      "complete",
      "fix",
      "replace",
    ],
  },
  run: {
    plain: [
      "rerun",
      "starte",
      "starten",
      "fuhre",
      "ausfuhren",
      "execute",
      "wiederhole",
      "wiederholen",
      "retry",
    ],
    positional: ["run", "start", "trigger", "repeat", "restart"],
  },
  save: {
    plain: ["save", "speichere", "speicher", "speichern", "sichere", "sichern"],
    positional: ["store", "keep"],
  },
};

const LEADERS = new Set([
  "bitte",
  "please",
  "und",
  "and",
  "dann",
  "then",
  "ja",
  "yes",
  "ok",
  "okay",
  "gut",
  "genau",
  "klar",
  "sure",
  "alright",
  "jetzt",
  "now",
  "also",
  "so",
  "just",
  "einfach",
  'let"s',
  "lets",
]);

const REQUEST_MARKERS: ReadonlyArray<readonly string[]> = [
  ["bitte"],
  ["please"],
  ["kannst", "du"],
  ["konntest", "du"],
  ["wurdest", "du"],
  ["magst", "du"],
  ["can", "you"],
  ["could", "you"],
  ["would", "you"],
  ["will", "you"],
  ["want", "you", "to"],
  ["need", "you", "to"],
  ["like", "you", "to"],
  ["go", "ahead"],
  ["mochte", "dass", "du"],
  ["will", "dass", "du"],
];

const BLOCKERS = new Set([
  "nicht",
  "nichts",
  "kein",
  "keine",
  "keinen",
  "keiner",
  "nie",
  "niemals",
  "not",
  "never",
  "dont",
  'don"t',
  'doesn"t',
  'won"t',
  'can"t',
  "cannot",
  'shouldn"t',
  "without",
  "ohne",
  "wenn",
  "falls",
  "sobald",
  "sofern",
  "if",
  "unless",
  "once",
  "when",
  "whenever",
  "until",
  "before",
  "bevor",
  "after",
  "nachdem",
  "erst",
  "vorher",
  "zuerst",
  "first",
  "later",
  "spater",
  "wait",
  "warte",
  "warten",
  "draft",
  "entwurf",
  "entwerfe",
  "vorschlag",
  "preview",
  "vorschau",
  "maybe",
  "vielleicht",
  "eventuell",
  "should",
  "sollte",
  "sollten",
  "soll",
  "sollen",
]);

const DRAFT_WORDS = new Set(["draft", "entwurf", "entwerfe"]);

const CONTENT_OPENERS = new Set([
  "dass",
  "that",
  "saying",
  "betreff",
  "subject",
  "inhalt",
  ":",
  '"',
]);

const QUESTION_OPENERS = new Set([
  "was",
  "wie",
  "warum",
  "wieso",
  "wann",
  "wo",
  "wer",
  "welche",
  "welcher",
  "welches",
  "hast",
  "hat",
  "habe",
  "haben",
  "ist",
  "sind",
  "wurde",
  "wurden",
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "which",
  "did",
  "has",
  "have",
  "is",
  "are",
  "were",
  "does",
  "do",
  "should",
  "soll",
  "sollte",
]);

interface Sentence {
  readonly start: number;
  readonly end: number;
  readonly contentStart: number;
  readonly question: boolean;
}

const TOKEN = /[\p{L}\p{N}]+(?:"\p{L}+)?|:(?=\s)|"|,|[.!?]+(?=\s|$)/gu;
const PUNCTUATION = /^[.!?:",]+$/u;

function tokenize(normalized: string): string[] {
  return [...normalized.matchAll(TOKEN)].map((match) => match[0]);
}

function isTerminator(token: string, previous: string | undefined): boolean {
  if (!/^[.!?]+$/u.test(token)) return false;
  return !(token === "." && previous !== undefined && /^\d+$/u.test(previous));
}

function sentencesOf(tokens: readonly string[]): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  let contentStart = -1;
  const close = (end: number, question: boolean) => {
    if (end > start) {
      out.push({ start, end, contentStart: contentStart === -1 ? end : contentStart, question });
    }
    start = end + 1;
    contentStart = -1;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (isTerminator(token, tokens[i - 1])) close(i, token.includes("?"));
    else if (contentStart === -1 && CONTENT_OPENERS.has(token) && (i > start || token === '"')) {
      contentStart = i;
    }
  }
  close(tokens.length, false);
  return out;
}

function quotedMask(tokens: readonly string[]): boolean[] {
  let inside = false;
  return tokens.map((token) => {
    if (token !== '"') return inside;
    inside = !inside;
    return true;
  });
}

function findSequence(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return -1;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function hasMarker(tokens: readonly string[], sentence: Sentence): boolean {
  const clause = tokens.slice(sentence.start, sentence.contentStart);
  return REQUEST_MARKERS.some((marker) => findSequence(clause, marker) !== -1);
}

function verbAt(token: string): { verb: RequestVerb; positional: boolean } | null {
  for (const verb of Object.keys(VERB_FORMS) as RequestVerb[]) {
    if (VERB_FORMS[verb].plain.includes(token)) return { verb, positional: false };
    if (VERB_FORMS[verb].positional.includes(token)) return { verb, positional: true };
  }
  return null;
}

function imperativePosition(tokens: readonly string[], sentence: Sentence, index: number): boolean {
  if (index === sentence.start) return true;
  const previous = tokens[index - 1] ?? "";
  if (previous === "," || LEADERS.has(previous)) return true;
  const beforePrevious = tokens[index - 2] ?? "";
  if ((previous === "you" || previous === "du") && index - 2 >= sentence.start) {
    return ["can", "could", "would", "will", "kannst", "konntest", "wurdest"].includes(
      beforePrevious,
    );
  }
  return previous === "to" && beforePrevious === "you";
}

export type RequestCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "not_a_request" | "conditional_or_negated" | "verb_mismatch";
      detail?: string;
    };

export function checkRequest(
  normalizedMessage: string,
  normalizedQuote: string,
  verbs: readonly ActionVerb[],
  options: { readonly draft?: boolean } = {},
): RequestCheck {
  const tokens = tokenize(normalizedMessage);
  const quoteTokens = tokenize(normalizedQuote).filter((token) => !PUNCTUATION.test(token));
  if (quoteTokens.length === 0) return { ok: false, reason: "not_a_request" };
  const exact = findSequence(
    tokens.filter((token) => !PUNCTUATION.test(token)),
    quoteTokens,
  );
  if (exact === -1) return { ok: false, reason: "not_a_request" };
  const wordIndexes: number[] = [];
  tokens.forEach((token, index) => {
    if (!PUNCTUATION.test(token)) wordIndexes.push(index);
  });
  const from = wordIndexes[exact] ?? -1;
  const to = wordIndexes[exact + quoteTokens.length - 1] ?? -1;
  const sentences = sentencesOf(tokens);
  const at = sentences.findIndex((sentence) => from >= sentence.start && from < sentence.end);
  const sentence = sentences[at];
  if (!sentence) return { ok: false, reason: "not_a_request" };
  const firstWord = tokens[sentence.start] ?? "";
  if (sentence.question && QUESTION_OPENERS.has(firstWord)) {
    return { ok: false, reason: "not_a_request", detail: "information question" };
  }
  for (const later of sentences.slice(at)) {
    for (let i = later.start; i < later.contentStart; i++) {
      const token = tokens[i] ?? "";
      if (BLOCKERS.has(token) && !(options.draft === true && DRAFT_WORDS.has(token))) {
        return { ok: false, reason: "conditional_or_negated", detail: token };
      }
    }
  }
  const marker = hasMarker(tokens, sentence);
  let otherVerb: string | null = null;
  const quoted = quotedMask(tokens);
  for (let i = Math.max(from, sentence.start); i <= to && i < sentence.contentStart; i++) {
    const found = quoted[i] ? null : verbAt(tokens[i] ?? "");
    if (!found) continue;
    const imperative = imperativePosition(tokens, sentence, i);
    if (!(imperative || (marker && !found.positional))) continue;
    if (verbs.includes(found.verb)) return { ok: true };
    otherVerb = tokens[i] ?? null;
  }
  return otherVerb
    ? { ok: false, reason: "verb_mismatch", detail: otherVerb }
    : { ok: false, reason: "not_a_request" };
}

export function namesRequest(normalizedText: string): boolean {
  const tokens = tokenize(normalizedText);
  const quoted = quotedMask(tokens);
  return tokens.some((token, index) => !quoted[index] && verbAt(token) !== null);
}
