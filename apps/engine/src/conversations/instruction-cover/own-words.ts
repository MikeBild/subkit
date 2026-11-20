import { normalizeForQuote } from "./normalize.ts";
import { namesRequest } from "./request.ts";

export const PASTED_MIN_LINES = 5;
export const PASTED_MIN_CHARS = 800;

const FENCE = /^\s*(?:```|~~~)/u;
const BLOCK_QUOTE = /^\s*>/u;

const FORWARD_MARKERS: readonly RegExp[] = [
  /^\s*-{2,}\s*(?:original message|urspr(?:ü|ue)ngliche nachricht|forwarded message|weitergeleitete nachricht)\s*-{2,}\s*$/iu,
  /^\s*(?:begin forwarded message|anfang der weitergeleiteten nachricht)\s*:?\s*$/iu,
  /^\s*(?:am|on)\b.{4,120}\b(?:schrieb|wrote)\b.{0,80}:\s*$/iu,
];

const MAIL_HEADER = /^\s*(?:from|von|to|an|cc|subject|betreff|date|datum|sent|gesendet)\s*:\s*\S/iu;

const MATERIAL =
  "(?:e-?mails?|mails?|nachrichten|nachricht|messages?|texte?|briefe?|letters?|threads?|verlauf|antwort(?:en)?|repl(?:y|ies)|anfragen?|requests?|tickets?|kommentare?|comments?|logs?|ausgaben?|outputs?|inhalte?|contents?|dokumente?|documents?|protokolle?|transcripts?|zitate?|quotes?|notizen?|notes?)";

const LEAD_INS: readonly RegExp[] = [
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:hier (?:ist|sind|kommt|kommen)|here (?:is|are)|here['’]s|below (?:is|are)|anbei|unten)\\b[^\\n:]{0,40}?(?<![\\p{L}\\p{N}])${MATERIAL}(?![\\p{L}\\p{N}])[^\\n:]{0,40}:`,
    "iu",
  ),
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:die|der|das|the|seine|ihre|his|her|their|folgende[rsn]?|following)\\s+${MATERIAL}\\s+(?:lautet|lauten|reads|says|unten|below|war|was|ist|is)(?![\\p{L}\\p{N}])[^\\n:]{0,40}:`,
    "iu",
  ),
  /(?<![\p{L}\p{N}])(?:er|sie|he|she|they|kunde|kundin|customer|client)\s+(?:schrieb|schreibt|schreiben|wrote|writes|said|says|sagte|sagt|meinte)(?![\p{L}\p{N}])[^\n:]{0,40}:/iu,
  /(?<![\p{L}\p{N}])(?:weitergeleitet|forwarded|fwd|zitat|quote|kopie|copy|eingef(?:ü|ue)gt|pasted)(?![\p{L}\p{N}])[^\n:]{0,40}:/iu,
];

function leadInEnd(line: string): number {
  let end = -1;
  for (const pattern of LEAD_INS) {
    const match = pattern.exec(line);
    if (!match) continue;
    const at = match.index + match[0].length;
    if (end === -1 || at < end) end = at;
  }
  return end;
}

function isPastedPassage(paragraph: string): boolean {
  const lines = paragraph.split("\n").filter((line) => line.trim().length > 0);
  return lines.length >= PASTED_MIN_LINES || paragraph.length >= PASTED_MIN_CHARS;
}

function ownParagraphs(raw: string): string[] {
  const lines = raw.replace(/\r\n?/gu, "\n").split("\n");
  const kept: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      fenced = !fenced;
      kept.push("");
      continue;
    }
    if (fenced || BLOCK_QUOTE.test(line)) {
      kept.push("");
      continue;
    }
    if (FORWARD_MARKERS.some((marker) => marker.test(line))) break;
    if (MAIL_HEADER.test(line) && MAIL_HEADER.test(lines[i + 1] ?? "")) break;
    const lead = leadInEnd(line);
    if (lead !== -1) {
      kept.push(line.slice(0, lead));
      break;
    }
    kept.push(line);
  }
  return kept
    .join("\n")
    .split(/\n\s*\n/u)
    .filter((paragraph) => !isPastedPassage(paragraph))
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function ownWords(raw: string): string {
  return ownParagraphs(raw).join("\n");
}

export const PASTED_BLOCK_MIN_LINES = 2;
export const SHORT_INSTRUCTION_MAX_LINES = 2;
export const SHORT_INSTRUCTION_MAX_CHARS = 200;
export const PASTED_BLOCK_SHARE = 1;
export const QUOTED_PASSAGE_MIN_WORDS = 3;

function lineCount(paragraph: string): number {
  return paragraph.split("\n").filter((line) => line.trim().length > 0).length;
}

const ASKING =
  /(?<![\p{L}\p{N}])(?:bitte|please|kannst du|k(?:ö|oe)nntest du|w(?:ü|ue)rdest du|can you|could you|would you|erledige|mach|do (?:that|this|it))(?![\p{L}\p{N}])/iu;

function asksForSomething(paragraph: string): boolean {
  return ASKING.test(paragraph) || namesRequest(normalizeForQuote(paragraph));
}

function withoutPastedBlock(paragraphs: readonly string[]): readonly string[] {
  if (paragraphs.length !== 2) return paragraphs;
  const [block = "", instruction = ""] = paragraphs;
  const shaped =
    lineCount(block) >= PASTED_BLOCK_MIN_LINES &&
    lineCount(instruction) <= SHORT_INSTRUCTION_MAX_LINES &&
    instruction.length <= SHORT_INSTRUCTION_MAX_CHARS &&
    block.length >= PASTED_BLOCK_SHARE * instruction.length;
  return shaped && asksForSomething(instruction) ? [instruction] : paragraphs;
}

const OPENING_MARK = '["„“«»]';
const CLOSING_MARK = '["“”«»]';
const QUOTED_SPAN = new RegExp(`${OPENING_MARK}([^"„“”«»]{1,4000})${CLOSING_MARK}`, "gu");
const OPEN_QUOTE_AFTER_COLON = new RegExp(`:\\s*${OPENING_MARK}[^"„“”«»]*$`, "u");

function wordsIn(text: string): number {
  return text.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function withoutQuotedPassages(paragraph: string): string {
  return paragraph
    .replace(QUOTED_SPAN, (span, inner: string) =>
      wordsIn(inner) >= QUOTED_PASSAGE_MIN_WORDS ? " " : span,
    )
    .replace(OPEN_QUOTE_AFTER_COLON, ":")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

export function requestWords(raw: string): string {
  return withoutPastedBlock(ownParagraphs(raw)).join("\n");
}

export function instructionWords(raw: string): string {
  return withoutPastedBlock(ownParagraphs(raw))
    .map(withoutQuotedPassages)
    .filter((paragraph) => paragraph.length > 0)
    .join("\n");
}
