import type { ChatPlatform } from "../types.ts";

export function formatChatText(platform: ChatPlatform, text: string): string {
  switch (platform) {
    case "slack":
      return convert(text, "slack");
    case "google_chat":
      return convert(text, "google_chat");
    case "teams":
    case "sk_cli":
      return text;
    default: {
      const _exhaustive: never = platform;
      return text;
    }
  }
}

type Dialect = "slack" | "google_chat";

const SENTINEL = "";

function convert(input: string, dialect: Dialect): string {
  if (!input) return input;

  const protectedSpans: string[] = [];
  const protect = (raw: string): string => {
    const idx = protectedSpans.length;
    protectedSpans.push(raw);
    return `${SENTINEL}${idx}${SENTINEL}`;
  };
  let text = input
    .replace(/```[\s\S]*?```/g, (m) => protect(m))
    .replace(/`[^`\n]+`/g, (m) => protect(m));

  text = convertTables(text);

  text = text
    .split("\n")
    .map((line) => transformLine(line, dialect))
    .join("\n");

  text = transformInline(text, dialect);

  text = text.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_m, i) => protectedSpans[Number(i)] ?? "",
  );

  return text;
}

function splitTableCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableSeparator(row: string): boolean {
  if (!row.includes("|")) return false;
  const cells = splitTableCells(row);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function unbold(cell: string): string {
  return cell.replace(/^\*\*(.+)\*\*$/, "$1").replace(/^__(.+)__$/, "$1");
}

function renderTableBlock(header: string[], rows: string[][]): string {
  return rows
    .map((cells) => {
      const head = `**${unbold(cells[0] ?? "")}**`;
      if (header.length === 2) return `${head}: ${cells[1] ?? ""}`;
      const bullets = cells
        .slice(1)
        .map((val, i) => `- ${header[i + 1] ?? ""}: ${val}`)
        .join("\n");
      return bullets ? `${head}\n${bullets}` : head;
    })
    .join("\n\n");
}

function convertTables(text: string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const next = lines[i + 1];
    if (isTableRow(line) && next !== undefined && isTableSeparator(next)) {
      const header = splitTableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "") && !isTableSeparator(lines[i] ?? "")) {
        rows.push(splitTableCells(lines[i] ?? ""));
        i++;
      }
      out.push(renderTableBlock(header, rows));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

function transformLine(line: string, _dialect: Dialect): string {
  const header = line.match(/^(\s*)#{1,6}\s+(.*)$/);
  if (header) {
    const indent = header[1] ?? "";
    const content = (header[2] ?? "").replace(/\s*#+\s*$/, "");
    return `${indent}**${content}**`;
  }

  const bullet = line.match(/^(\s*)[-*•](\s+)(.*)$/);
  if (bullet) {
    const indent = bullet[1] ?? "";
    const space = bullet[2] ?? " ";
    const content = bullet[3] ?? "";
    return `${indent}*${space}${content}`;
  }

  return line;
}

function transformInline(text: string, _dialect: Dialect): string {
  let out = text;

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => `<${url}|${label}>`);

  out = out.replace(/\*\*([^\n]+?)\*\*/g, (_m, inner) => `*${inner}*`);
  out = out.replace(/__([^\n]+?)__/g, (_m, inner) => `*${inner}*`);

  out = out.replace(/~~([^\n]+?)~~/g, (_m, inner) => `~${inner}~`);

  return out;
}
