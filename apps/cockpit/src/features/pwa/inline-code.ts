export type InlinePart = { kind: "text" | "code"; value: string };

export function inlineCodeParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let plain = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("`", index);
    const close = open === -1 ? -1 : text.indexOf("`", open + 1);
    if (open === -1 || close === -1) {
      plain += text.slice(index);
      break;
    }
    const code = text.slice(open + 1, close);
    if (code.trim() === "") {
      plain += text.slice(index, close + 1);
      index = close + 1;
      continue;
    }
    plain += text.slice(index, open);
    if (plain) parts.push({ kind: "text", value: plain });
    plain = "";
    parts.push({ kind: "code", value: code });
    index = close + 1;
  }
  if (plain) parts.push({ kind: "text", value: plain });
  return parts;
}
