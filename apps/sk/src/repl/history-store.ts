import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { trimJsonlFile } from "@shared/jsonl-ring.ts";

export interface HistoryEntry {
  t: number;
  p: string;
  tenant?: string | null;
}

export const MAX_HISTORY = 500;

export const MAX_PROMPT_HISTORY = 10_000;

export function defaultHistoryPath(): string {
  return join(homedir(), ".sk", "history.jsonl");
}

export function defaultSlashHistoryPath(): string {
  return join(homedir(), ".sk", "slash-history.jsonl");
}

const SLASH_RING_MAX = 1_000;

export function loadHistory(path: string = defaultHistoryPath()): HistoryEntry[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (typeof entry.p === "string" && typeof entry.t === "number") {
        out.push(entry);
      }
    } catch {}
  }
  return out;
}

export function appendHistory(
  prompt: string,
  opts: { path?: string; tenant?: string | null } = {},
): void {
  const p = prompt.trim();
  if (p.length === 0) return;
  const path = opts.path ?? defaultHistoryPath();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }

  const existing = loadHistory(path);
  const last = existing[existing.length - 1];
  if (last && last.p === p) return;

  const entry: HistoryEntry = {
    t: Date.now(),
    p,
    ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
  };
  const line = `${JSON.stringify(entry)}\n`;

  if (existing.length + 1 <= MAX_PROMPT_HISTORY) {
    try {
      appendFileSync(path, line, { mode: 0o600 });
    } catch {}
    return;
  }

  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const after = readFileSync(path, "utf8");
    trimJsonlFile(path, after, MAX_PROMPT_HISTORY);
  } catch {}
}

export function clearHistory(path: string = defaultHistoryPath()): void {
  try {
    if (existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  } catch {}
}

export function loadPromptRing(
  path: string = defaultHistoryPath(),
  opts: { tenant?: string | null; limit?: number } = {},
): string[] {
  const entries = loadHistory(path);
  const filtered = opts.tenant ? entries.filter((e) => e.tenant === opts.tenant) : entries;
  const limit = opts.limit ?? MAX_PROMPT_HISTORY;
  return filtered.slice(Math.max(0, filtered.length - limit)).map((e) => e.p);
}

export interface SlashHistoryEntry {
  t: number;
  s: string;
  tenant?: string | null;
}

export function appendSlashHistory(
  invocation: string,
  opts: { path?: string; tenant?: string | null } = {},
): void {
  const s = invocation.trim();
  if (!s.startsWith("/")) return;
  if (s.length === 0) return;
  const path = opts.path ?? defaultSlashHistoryPath();
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  } catch {
    return;
  }
  const existing = loadSlashHistory(path);
  const last = existing[existing.length - 1];
  if (last && last.s === s) return;
  const entry: SlashHistoryEntry = {
    t: Date.now(),
    s,
    ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
  };
  if (existing.length + 1 <= SLASH_RING_MAX) {
    try {
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {}
    return;
  }
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const after = readFileSync(path, "utf8");
    trimJsonlFile(path, after, SLASH_RING_MAX);
  } catch {}
}

export function loadSlashHistory(path: string = defaultSlashHistoryPath()): SlashHistoryEntry[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: SlashHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as SlashHistoryEntry;
      if (typeof entry.s === "string" && typeof entry.t === "number") out.push(entry);
    } catch {}
  }
  return out;
}

export function loadSlashRing(
  path: string = defaultSlashHistoryPath(),
  opts: { tenant?: string | null; limit?: number } = {},
): string[] {
  const entries = loadSlashHistory(path);
  const filtered = opts.tenant ? entries.filter((e) => e.tenant === opts.tenant) : entries;
  const limit = opts.limit ?? SLASH_RING_MAX;
  return filtered.slice(Math.max(0, filtered.length - limit)).map((e) => e.s);
}

export function clearSlashHistory(path: string = defaultSlashHistoryPath()): void {
  try {
    if (existsSync(path)) writeFileSync(path, "");
  } catch {}
}
