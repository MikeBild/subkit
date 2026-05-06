// Locate slash-command spans in the prompt input.
//
// Recognizes a `/word` token only when it sits at the start of the
// buffer, the start of a line, or right after whitespace — so
// "hello/world" inside a sentence does NOT highlight as a command.
//
// The cursor argument lets callers ask "is the cursor inside (or at
// the end of) a slash token right now?" — that's how SlashSuggest
// decides whether to show suggestions for the current keystroke.

export interface SlashSpan {
  /** Inclusive start index — points to the `/` character. */
  start: number;
  /** Exclusive end index — points one past the last name character. */
  end: number;
  /** Just the name without the leading slash. Empty string if the user
   *  typed `/` and nothing else yet. */
  name: string;
}

const SLASH_NAME_CHAR = /[A-Za-z0-9_-]/;

export function findSlashCommandPositions(buffer: string): SlashSpan[] {
  const out: SlashSpan[] = [];
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== "/") continue;
    // Anchor: only at start, after whitespace, or after a newline.
    const prev = i === 0 ? "" : (buffer[i - 1] ?? "");
    if (prev !== "" && prev !== "\n" && !/\s/.test(prev)) continue;
    let j = i + 1;
    while (j < buffer.length && SLASH_NAME_CHAR.test(buffer[j] as string)) j++;
    out.push({ start: i, end: j, name: buffer.slice(i + 1, j) });
    i = j;
  }
  return out;
}

/** Return the slash span that contains (or sits at the end of) the
 *  cursor position, or null if the cursor isn't inside a slash token. */
export function spanAtCursor(buffer: string, cursor: number): SlashSpan | null {
  const spans = findSlashCommandPositions(buffer);
  for (const s of spans) {
    if (cursor >= s.start && cursor <= s.end) return s;
  }
  return null;
}
