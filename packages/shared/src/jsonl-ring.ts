import { renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface JsonlTrimOptions {
  mode?: number;
}

export function trimJsonlFile(
  path: string,
  content: string,
  keep: number,
  opts: JsonlTrimOptions = {},
): { trimmed: boolean; kept?: number } {
  const lines = content.split("\n").filter((l) => l.length > 0);
  if (lines.length <= keep) return { trimmed: false };
  const head = Math.max(0, lines.length - keep);
  const trimmed = lines.slice(head).join("\n");
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const mode = opts.mode ?? 0o600;
  try {
    writeFileSync(tmp, `${trimmed}\n`, { encoding: "utf8", mode });
    renameSync(tmp, path);
    return { trimmed: true, kept: lines.length - head };
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
    return { trimmed: false };
  }
}
