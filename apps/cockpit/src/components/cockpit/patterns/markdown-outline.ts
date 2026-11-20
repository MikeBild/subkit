export interface OutlineEntry {
  level: number;
  text: string;
}

export const OUTLINE_MIN_HEADINGS = 3;

function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

export function markdownOutline(markdown: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const mark = /^\s{0,3}(```+|~~~+)/.exec(line)?.[1] ?? null;
    if (mark) {
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const text = heading ? plain(heading[2] ?? "") : "";
    if (heading && text) entries.push({ level: heading[1]?.length ?? 1, text });
  }
  return entries;
}

export function showsOutline(entries: readonly OutlineEntry[]): boolean {
  return entries.length >= OUTLINE_MIN_HEADINGS;
}

export function outlineIndent(entries: readonly OutlineEntry[], entry: OutlineEntry): number {
  const top = Math.min(...entries.map((item) => item.level));
  return Math.min(2, entry.level - top);
}
