export type RenderableMessagePart =
  | { type: "text"; text: string }
  | { type: "code_block"; code: string; language?: string | undefined }
  | { type: "table"; headers: string[]; rows: string[][] };

export function parseRenderableMessageContent(content: unknown): {
  text: string;
  parts: RenderableMessagePart[];
} {
  const extracted = extractTextSegments(content);
  const text =
    extracted.length > 0
      ? extracted.join("\n\n")
      : isEffectivelyEmpty(content)
        ? ""
        : safeStringify(content);
  if (text.length === 0) return { text, parts: [] };
  return { text, parts: splitRenderableParts(text) };
}

function isEffectivelyEmpty(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return Object.keys(content as object).length === 0;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextSegments(content: unknown): string[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (Array.isArray(content)) {
    return content.flatMap((item) => extractTextSegments(item));
  }
  if (typeof content !== "object") return [String(content)];

  const rec = content as Record<string, unknown>;
  if (typeof rec.text === "string") {
    return rec.text.length > 0 ? [rec.text] : [];
  }
  if (Array.isArray(rec.parts)) {
    return rec.parts.flatMap((part) => extractTextSegments(part));
  }
  if (Array.isArray(rec.content)) {
    return rec.content.flatMap((part) => extractTextSegments(part));
  }
  if (typeof rec.content === "string") {
    return rec.content.length > 0 ? [rec.content] : [];
  }
  return [];
}

function splitRenderableParts(source: string): RenderableMessagePart[] {
  const lines = source.split("\n");
  const parts: RenderableMessagePart[] = [];
  let textBuffer: string[] = [];

  const flushText = (): void => {
    const text = textBuffer
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    textBuffer = [];
    if (text.length > 0) parts.push({ type: "text", text });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^```([\w.+-]+)?\s*$/);
    if (fence) {
      const end = findFenceEnd(lines, i + 1);
      if (end !== null) {
        flushText();
        const code = lines
          .slice(i + 1, end)
          .join("\n")
          .replace(/\n+$/, "");
        parts.push({
          type: "code_block",
          code,
          ...(fence[1] ? { language: fence[1] } : {}),
        });
        i = end;
        continue;
      }
    }

    if (isMarkdownTable(lines, i)) {
      flushText();
      const table = consumeMarkdownTable(lines, i);
      parts.push(table.part);
      i = table.lastIndex;
      continue;
    }

    textBuffer.push(line);
  }

  flushText();
  return parts.length > 0 ? parts : [{ type: "text", text: source }];
}

function findFenceEnd(lines: string[], start: number): number | null {
  for (let i = start; i < lines.length; i++) {
    if (/^```\s*$/.test(lines[i] ?? "")) return i;
  }
  return null;
}

function isMarkdownTable(lines: string[], index: number): boolean {
  const header = splitTableCells(lines[index] ?? "");
  const separator = splitTableCells(lines[index + 1] ?? "");
  return (
    header.length >= 2 &&
    separator.length === header.length &&
    separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function consumeMarkdownTable(
  lines: string[],
  start: number,
): { part: Extract<RenderableMessagePart, { type: "table" }>; lastIndex: number } {
  const headers = splitTableCells(lines[start] ?? "");
  const rows: string[][] = [];
  let cursor = start + 2;
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor] ?? "";
    if (!line.includes("|")) break;
    const cells = splitTableCells(line);
    if (cells.length === 0) break;
    rows.push(normalizeRowWidth(cells, headers.length));
  }
  return {
    part: { type: "table", headers, rows },
    lastIndex: cursor - 1,
  };
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const withoutLeading = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = withoutLeading.endsWith("|")
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
  return withoutTrailing.split("|").map((cell) => cell.trim());
}

function normalizeRowWidth(cells: string[], width: number): string[] {
  if (cells.length === width) return cells;
  if (cells.length > width) return cells.slice(0, width);
  return [...cells, ...Array.from({ length: width - cells.length }, () => "")];
}
