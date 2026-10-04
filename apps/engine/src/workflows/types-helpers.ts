export const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function parseHeaderLines(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let saw = 0;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) return null;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name) return null;
    if (!HTTP_TOKEN_RE.test(name)) return null;
    out[name] = value;
    saw += 1;
  }
  return saw > 0 ? out : null;
}

export function looksLikeJsonObjectOrArray(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!(first === "{" && last === "}") && !(first === "[" && last === "]")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && (typeof parsed === "object" || Array.isArray(parsed));
  } catch {
    return false;
  }
}
