// What an internal identifier is allowed to look like in an answer.
//
// Identifiers are banned from every surface, so the transcript used to run one
// regular expression over the whole message and put a phrase where every
// identifier had been. That is right for a sentence and wrong for a payload.
// An answer that says
//
//     POST /v1/executions  {"source":"saved","workflow_id":"5f47b19e-…"}
//
// rendered as `"workflow_id":"internal reference"`, and a reader who copied it
// copied something that cannot work. The display layer had quietly falsified
// what the agent said.
//
// So the text is split first, and the two halves get opposite treatment:
//
//   - Code — fenced blocks and inline spans — is left exactly as written. It
//     is a value to be used, not prose to be read, and an identifier inside it
//     is the point.
//   - Prose gets the name of the thing instead, as a link, whenever the
//     conversation knows which thing it is. Only when nothing resolves does the
//     phrase remain, because then there is genuinely nothing to say.
//
// The splitter is deliberately one function used by both rules: a second copy
// is how "what counts as code" starts disagreeing with itself.

/** A run of the message, and whether it is code. */
export interface TextSegment {
  text: string;
  code: boolean;
}

// Fenced blocks first so an inline backtick inside a fence cannot open a span.
const CODE_PATTERN = /(```[\s\S]*?```|``[\s\S]*?``|`[^`\n]*`)/g;

/** Split a markdown message into code runs and prose runs, in order. */
export function splitCodeAndProse(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(CODE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: text.slice(last, start), code: false });
    segments.push({ text: match[0], code: true });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), code: false });
  return segments;
}

/** What the conversation knows about one identifier it mentions. */
export interface ResolvedIdentifier {
  label: string;
  /** Where the reader can go to see it, when there is such a place. */
  href?: string | null;
}

// Kept in step with `presentation.ts`: production history holds identifiers
// whose version nibble is not RFC-conformant, and they are just as opaque.
const IDENTIFIER_PATTERN =
  /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gi;

/** Markdown link text and titles are not places to smuggle syntax through. */
function escapeLinkText(value: string): string {
  return value.replace(/([[\]])/g, "\\$1");
}

/**
 * Name the identifiers in an answer, and leave the ones in code alone.
 *
 * The result is still markdown: a resolved identifier becomes a link, so the
 * existing renderer draws it and the reader can go and look. Nothing here
 * renders — keeping it a string transform is what lets the whole message stay
 * one markdown document rather than a row of spans with the formatting lost.
 */
export function nameIdentifiers(
  text: string,
  resolve: (id: string) => ResolvedIdentifier | null,
  hiddenLabel: string,
): string {
  return splitCodeAndProse(text)
    .map((segment) => {
      if (segment.code) return segment.text;
      return segment.text.replace(IDENTIFIER_PATTERN, (id) => {
        const known = resolve(id);
        if (!known) return hiddenLabel;
        const label = escapeLinkText(known.label);
        return known.href ? `[${label}](${known.href})` : label;
      });
    })
    .join("");
}
