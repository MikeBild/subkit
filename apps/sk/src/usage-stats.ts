import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

function prefsDir(): string {
  return join(process.env.HOME ?? homedir(), ".sk");
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
    if (parsed.success) {
      if (parsed.data.version === SCHEMA_VERSION) return parsed.data;
    }
  } catch {}
  return { version: SCHEMA_VERSION, counts: {} };
}

function writePrefs(prefs: PrefsShape): void {
  const path = prefsPath();
  try {
    mkdirSync(prefsDir(), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(prefs));
    renameSync(tmp, path);
  } catch {}
}

export function getUsageCount(commandName: string): number {
  return readPrefs().counts[commandName] ?? 0;
}

export function recordUsage(commandName: string): void {
  const prefs = readPrefs();
  const next = { ...prefs.counts, [commandName]: (prefs.counts[commandName] ?? 0) + 1 };
  writePrefs({ version: SCHEMA_VERSION, counts: next });
}

export function getAllUsageCounts(): Record<string, number> {
  return { ...readPrefs().counts };
}

export function frequencyBias(commandName: string): number {
  return Math.log(getUsageCount(commandName) + 1);
}
