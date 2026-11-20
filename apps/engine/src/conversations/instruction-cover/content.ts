import { isContentKey } from "./bound-action.ts";
import { normalizeForQuote, occursBounded } from "./normalize.ts";
import { canonicalNumber, numberCandidates, type SpokenFacts } from "./spoken.ts";

export const MAX_GIVEN_CONTENT_CHARS = 1200;
export const MAX_FULL_CONTENT_CHARS = 8000;
export const ADDED_WORD_SHARE = 0.25;
export const ADDED_WORD_LIMIT = 3;
export const ADDED_WORD_FLOOR_FROM = 3;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const URL_RE = /https?:\/\/[^\s<>"'„“”‚‘’»«]+/gu;
const HANDLE = /(?<![\p{L}\p{N}])[@#][\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu;
const TRAILING = /[.,;:!?)\]}]+$/u;
const WORD = /\p{L}+(?:"\p{L}+)?/gu;
const NUMBER = /\d+(?:[.,]\d+)*/gu;

const NEUTRAL = new Set(
  [
    "der die das den dem des ein eine einen einem einer eines und oder aber auch noch schon nur",
    "ich du er sie es wir ihr mich mir dich dir uns euch mein meine dein deine sein seine unser",
    "ist sind war waren bin bist wird werden wurde hat habe haben hatte kann konnen muss mussen",
    "in im an am auf aus bei mit nach von vom vor zu zum zur uber unter fur um durch gegen bis",
    "dass ob wie was wer wo wann als wenn denn weil so sehr hier da dort dann heute gerade",
    "the a an and or but also just only i you he she it we they me my your his her its our their",
    "is are was were am be been being has have had will would can could do does did",
    "in on at to of for from with by about into over under as that this these those there here",
    "hallo hi hello hey dear liebe lieber guten tag moin servus gruss grusse viele beste herzliche",
    "vielen herzlichen besten lieben dank",
    "freundliche freundlichen regards best kind thanks thank danke dankeschon bitte please",
    "anbei attached fyi cheers sincerely mfg lg vg geehrte geehrter",
  ]
    .join(" ")
    .split(" "),
);

const NEGATIONS = new Set([
  "nicht",
  "nichts",
  "kein",
  "keine",
  "keinen",
  "keinem",
  "keiner",
  "keines",
  "nie",
  "niemals",
  "not",
  "no",
  "never",
  "none",
  "cannot",
  "without",
  "ohne",
]);

export type ContentCheck =
  | { readonly ok: true; readonly basis: "none" | "given" | "shown" }
  | { readonly ok: false; readonly detail: string };

function strings(value: unknown, into: string[], depth: number): void {
  if (depth > 8 || into.length > 200) return;
  if (typeof value === "string") {
    if (value.trim().length > 0) into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) strings(item, into, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      strings(nested, into, depth + 1);
    }
  }
}

function collect(value: unknown, into: string[], depth: number): void {
  if (depth > 8 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isContentKey(key)) strings(nested, into, depth + 1);
    else collect(nested, into, depth + 1);
  }
}

export function collectContent(tool: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (tool !== "call_connector") {
    collect(args, out, 0);
    return out;
  }
  let body: unknown = args.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      return [body as string];
    }
  }
  collect(body, out, 0);
  return out;
}

export function fullContent(fields: readonly string[]): string | null {
  if (fields.length === 0) return null;
  const joined = fields.join("\n\n");
  return joined.length > MAX_FULL_CONTENT_CHARS
    ? `${joined.slice(0, MAX_FULL_CONTENT_CHARS - 1)}…`
    : joined;
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function wordGiven(word: string, spoken: ReadonlySet<string>, text: string): boolean {
  if (spoken.has(word)) return true;
  if (word.length < 4) return false;
  if (text.includes(word)) return true;
  for (const said of spoken) {
    if (said.length < 4) continue;
    const shared = commonPrefix(said, word);
    if (shared >= Math.max(4, Math.ceil(Math.min(said.length, word.length) * 0.6))) return true;
  }
  return false;
}

function numberGiven(token: string, facts: SpokenFacts): boolean {
  if (numberCandidates(token).some((candidate) => facts.numbers.has(candidate))) return true;
  return token
    .split(/[.,]/u)
    .filter((part) => part.length > 0)
    .every((part) => facts.numbers.has(canonicalNumber(Number(part))));
}

function givenFailure(fields: readonly string[], facts: SpokenFacts): string | null {
  const total = fields.reduce((sum, field) => sum + field.length, 0);
  if (total > MAX_GIVEN_CONTENT_CHARS) return "the text is longer than what the person wrote";
  const said = facts.text.toLowerCase();
  const spoken = new Set(said.match(WORD) ?? []);
  const added: string[] = [];
  let meaningful = 0;
  for (const field of fields) {
    for (const match of field.matchAll(URL_RE)) {
      const url = match[0].replace(TRAILING, "");
      if (!facts.urls.has(url)) return `adds the link ${url}`;
    }
    const withoutUrls = field.replace(URL_RE, " ");
    for (const match of withoutUrls.matchAll(EMAIL)) {
      const email = match[0].replace(TRAILING, "");
      if (!facts.emails.has(email)) return `adds the address ${email}`;
    }
    const withoutAddresses = withoutUrls.replace(EMAIL, " ");
    for (const match of withoutAddresses.matchAll(HANDLE)) {
      const handle = match[0].replace(TRAILING, "");
      if (!facts.handles.has(handle)) return `adds ${handle}`;
    }
    const plain = normalizeForQuote(withoutAddresses.replace(HANDLE, " ")).toLowerCase();
    for (const match of plain.matchAll(NUMBER)) {
      if (!numberGiven(match[0], facts)) return `adds the number ${match[0]}`;
    }
    for (const word of plain.match(WORD) ?? []) {
      if (NEGATIONS.has(word) || /n"t$/u.test(word)) {
        if (!spoken.has(word)) return `adds "${word}"`;
        continue;
      }
      if (word.length < 3 || NEUTRAL.has(word)) continue;
      meaningful += 1;
      if (!wordGiven(word, spoken, said)) added.push(word);
    }
  }
  const allowed =
    meaningful < ADDED_WORD_FLOOR_FROM
      ? 0
      : Math.min(ADDED_WORD_LIMIT, Math.max(1, Math.floor(meaningful * ADDED_WORD_SHARE)));
  return added.length > allowed
    ? `adds words the person did not write: ${added.slice(0, 6).join(", ")}`
    : null;
}

export function checkContent(
  fields: readonly string[],
  facts: SpokenFacts,
  shown: readonly string[],
): ContentCheck {
  if (fields.length === 0) return { ok: true, basis: "none" };
  const seen = shown.map((text) => normalizeForQuote(text));
  const drafted = fields.filter((field) => {
    const normalized = normalizeForQuote(field);
    return !(normalized.length > 0 && seen.some((text) => occursBounded(normalized, text)));
  });
  if (drafted.length === 0) return { ok: true, basis: "shown" };
  const failure = givenFailure(drafted, facts);
  return failure === null ? { ok: true, basis: "given" } : { ok: false, detail: failure };
}
