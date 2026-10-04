import { isSlashNameChar } from "../../slash.ts";

export interface SlashSpan {
  start: number;
  end: number;
  name: string;
}

export function findSlashCommandPositions(buffer: string): SlashSpan[] {
  const out: SlashSpan[] = [];
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== "/") continue;
    const prev = i === 0 ? "" : (buffer[i - 1] ?? "");
    if (prev !== "" && prev !== "\n" && !/\s/.test(prev)) continue;
    let j = i + 1;
    while (j < buffer.length && isSlashNameChar(buffer[j] as string)) j++;
    out.push({ start: i, end: j, name: buffer.slice(i + 1, j) });
    i = j;
  }
  return out;
}

export function spanAtCursor(buffer: string, cursor: number): SlashSpan | null {
  const spans = findSlashCommandPositions(buffer);
  for (const s of spans) {
    if (cursor >= s.start && cursor <= s.end) return s;
  }
  return null;
}
