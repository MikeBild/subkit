// OSC 52 clipboard helper. Writes the target string into the
// terminal's system clipboard via the OSC 52 escape sequence —
// works over SSH / tmux without shelling out. Host runtimes
// (macOS Terminal, iTerm2, WezTerm, Kitty, tmux passthrough) all
// support this sequence; older terminals silently ignore it.

export interface ClipboardOptions {
  /** Writable stream (defaults to `process.stdout`). */
  stream?: NodeJS.WriteStream;
  /** Max bytes of base64 payload allowed (iTerm2 caps around 1MB; conservative at 512KB). */
  maxBytes?: number;
}

/**
 * Write `text` to the system clipboard via OSC 52. Returns true if
 * the sequence was written (not a guarantee the terminal honored it).
 */
export function osc52Copy(text: string, opts: ClipboardOptions = {}): boolean {
  const stream = opts.stream ?? process.stdout;
  if (!stream.isTTY) return false;
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const payload = Buffer.from(text, "utf8").toString("base64");
  if (payload.length > maxBytes) return false;
  // `\x1b]52;c;<base64>\x07` — the `c` selector targets the system clipboard.
  stream.write(`\x1b]52;c;${payload}\x07`);
  return true;
}

/** Ring the terminal bell once. No-op if stdout is not a TTY. */
export function ringBell(opts: ClipboardOptions = {}): void {
  const stream = opts.stream ?? process.stdout;
  if (!stream.isTTY) return;
  stream.write("\x07");
}
