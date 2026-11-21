export interface Heading {
  level: number;
  text: string;
  id: string;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-") || "abschnitt";

export function headings(md: string): Heading[] {
  const out: Heading[] = [];
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = (m[2] ?? "").replace(/[*_`]/g, "");
    const base = slug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ level: m[1]?.length ?? 1, text, id: n ? `${base}-${n}` : base });
  }
  return out;
}

export function stripTitleHeading(md: string, title: string): string {
  const trimmed = md.trimStart();
  const m = /^#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(trimmed);
  if (!m) return md;
  const text = (m[1] ?? "").replace(/[*_`]/g, "").trim();
  return text === title.trim() ? trimmed.slice(m[0].length).replace(/^\n+/, "") : md;
}

export type Fmt = "heading" | "bold" | "italic" | "list" | "olist" | "link" | "code";
export interface Edit {
  value: string;
  start: number;
  end: number;
}

export function insertText(v: string, a: number, b: number, text: string): Edit {
  const value = v.slice(0, a) + text + v.slice(b);
  return { value, start: a + text.length, end: a + text.length };
}

function wrap(v: string, a: number, b: number, l: string, r = l): Edit {
  const sel = v.slice(a, b);
  return {
    value: v.slice(0, a) + l + sel + r + v.slice(b),
    start: a + l.length,
    end: a + l.length + sel.length,
  };
}

function prefixLines(v: string, a: number, b: number, prefix: (i: number) => string): Edit {
  const ls = v.lastIndexOf("\n", a - 1) + 1;
  const leRaw = v.indexOf("\n", b);
  const le = leRaw === -1 ? v.length : leRaw;
  const lines = v
    .slice(ls, le)
    .split("\n")
    .map((line, i) => prefix(i) + line.replace(/^(#{1,6}\s|-\s|\d+\.\s)/, ""));
  const block = lines.join("\n");
  return { value: v.slice(0, ls) + block + v.slice(le), start: ls, end: ls + block.length };
}

export function applyFormat(v: string, a: number, b: number, f: Fmt, linkText = "Link"): Edit {
  switch (f) {
    case "bold":
      return wrap(v, a, b, "**");
    case "italic":
      return wrap(v, a, b, "_");
    case "code":
      return v.slice(a, b).includes("\n") ? wrap(v, a, b, "```\n", "\n```") : wrap(v, a, b, "`");
    case "heading":
      return prefixLines(v, a, b, () => "## ");
    case "list":
      return prefixLines(v, a, b, () => "- ");
    case "olist":
      return prefixLines(v, a, b, (i) => `${i + 1}. `);
    case "link": {
      const label = v.slice(a, b) || linkText;
      const text = `[${label}](https://)`;
      const value = v.slice(0, a) + text + v.slice(b);
      const urlStart = a + label.length + 3;
      return { value, start: urlStart, end: urlStart + 8 };
    }
  }
}

export const refToken = (prefix: string, name: string) => `@${prefix}:${name}`;
