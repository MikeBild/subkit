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
import { z } from "zod";

// PREFS_DIR / PREFS_PATH are resolved lazily so test setup can override
// HOME before the first call. A pinned const at module load would freeze
// the path to whichever HOME was set when the module first imported —
// which is fragile under parallel `bun test` because the dev's real
// ~/.sk/prefs.json would get written across the entire suite.
function prefsDir(): string {
  return join(homedir(), ".sk");
}
function prefsPath(): string {
  return join(prefsDir(), "prefs.json");
}
const SCHEMA_VERSION = 1;

const PrefsSchema = z.object({
  version: z.number(),
  counts: z.record(z.string(), z.number()),
});
type PrefsShape = z.infer<typeof PrefsSchema>;

function readPrefs(): PrefsShape {
  const path = prefsPath();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = PrefsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or unreadable — fall through to empty defaults.
  }
  return { version: SCHEMA_VERSION, counts: {} };
}

function writePrefs(prefs: PrefsShape): void {
  const path = prefsPath();
  try {
    mkdirSync(prefsDir(), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(prefs));
    renameSync(tmp, path);
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

/** Increment a single command's usage count. Safe to call on every
 *  dispatch. Test isolation is the caller's responsibility — tests that
 *  cross-talk through this file must redirect HOME to a tempdir
 *  (`apps/sk/src/tests/ink-app.test.tsx` and `usage-stats.test.ts` both
 *  do this). The production path is unconditional. */
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
