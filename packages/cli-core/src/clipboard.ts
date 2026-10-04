export interface ClipboardOptions {
  stream?: NodeJS.WriteStream;
  maxBytes?: number;
}

export function osc52Copy(text: string, opts: ClipboardOptions = {}): boolean {
  const stream = opts.stream ?? process.stdout;
  if (!stream.isTTY) return false;
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const payload = Buffer.from(text, "utf8").toString("base64");
  if (payload.length > maxBytes) return false;
  stream.write(`\x1b]52;c;${payload}\x07`);
  return true;
}

export function ringBell(opts: ClipboardOptions = {}): void {
  const stream = opts.stream ?? process.stdout;
  if (!stream.isTTY) return;
  stream.write("\x07");
}
