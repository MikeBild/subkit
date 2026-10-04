const DEFAULT_MAX_LEN = 200;

export function sanitizeForAudit(input: string, maxLen: number = DEFAULT_MAX_LEN): string {
  let out = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out;
}
