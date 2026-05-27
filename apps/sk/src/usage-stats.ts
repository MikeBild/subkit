// Per-profile slash-command frequency tracker.
//
// Drives the autocomplete sort in `slash.ts` — Fuse fuzzy score plus
// `log(usage_count + 1)`, so the commands an operator runs most often
// float to the top of the picker. Counts persist to
// `~/.sk/prefs.json` and are atomically updated (temp-file + rename)
// so concurrent sk processes never corrupt the file.
//
// The file format is intentionally minimal:
//   { "version": 1, "counts": { "/workflows": 42, "/executions": 19 } }
//
// Unknown commands count as zero. Missing file is treated as empty.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PREFS_DIR = join(homedir(), ".sk");
const PREFS_PATH = join(PREFS_DIR, "prefs.json");
const SCHEMA_VERSION = 1;

interface PrefsShape {
  version: number;
  counts: Record<string, number>;
}

let cached: PrefsShape | null = null;

function readPrefs(): PrefsShape {
  if (cached) return cached;
  try {
    const raw = readFileSync(PREFS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.version === "number" &&
      parsed.counts &&
      typeof parsed.counts === "object"
    ) {
      cached = { version: parsed.version, counts: parsed.counts as Record<string, number> };
      return cached;
    }
  } catch {
    // Missing or unreadable — fall through to empty defaults.
  }
  cached = { version: SCHEMA_VERSION, counts: {} };
  return cached;
}

function writePrefs(prefs: PrefsShape): void {
  try {
    mkdirSync(PREFS_DIR, { recursive: true });
    const tmp = `${PREFS_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(prefs));
    renameSync(tmp, PREFS_PATH);
    cached = prefs;
  } catch {
    // Best-effort: prefs are a usability optimisation, never a hard
    // dependency. A failed write means the next picker still works
    // — it just doesn't see the bumped count.
  }
}

/** Return the persisted usage count for one slash command name (no leading slash). */
export function getUsageCount(commandName: string): number {
  return readPrefs().counts[commandName] ?? 0;
}

/** Increment a single command's usage count. Safe to call on every dispatch. */
export function recordUsage(commandName: string): void {
  const prefs = readPrefs();
  const next = { ...prefs.counts, [commandName]: (prefs.counts[commandName] ?? 0) + 1 };
  writePrefs({ version: SCHEMA_VERSION, counts: next });
}

/** Bulk snapshot — used by the slash picker so a sort over all visible commands hits the disk once. */
export function getAllUsageCounts(): Record<string, number> {
  return { ...readPrefs().counts };
}

/** Frequency bias term: `log(usage_count + 1)`. Caller blends with Fuse score. */
export function frequencyBias(commandName: string): number {
  return Math.log(getUsageCount(commandName) + 1);
}
