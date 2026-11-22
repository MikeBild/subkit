export const CRASH_LIMIT = 10;
export const CRASH_FILE = "crashes.json";

export type CrashSource = "renderer" | "child" | "gpu";

export interface CrashEntry {
  at: string;
  source: CrashSource;
  process: string;
  reason: string;
  exitCode: number | null;
}

export interface GoneDetails {
  reason: string;
  exitCode?: number | undefined;
  type?: string | undefined;
  name?: string | undefined;
  serviceName?: string | undefined;
}

const QUIET_REASONS = new Set(["clean-exit", "killed"]);

export function isCrash(details: GoneDetails): boolean {
  return !QUIET_REASONS.has(details.reason);
}

export function crashEntry(
  source: CrashSource,
  details: GoneDetails,
  at: string,
  label?: string,
): CrashEntry {
  const process = label ?? details.serviceName ?? details.name ?? details.type ?? source;
  return {
    at,
    source,
    process: process.slice(0, 80),
    reason: details.reason.slice(0, 80),
    exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
  };
}

export function appendCrash(
  list: readonly CrashEntry[],
  entry: CrashEntry,
  limit = CRASH_LIMIT,
): CrashEntry[] {
  return [...list, entry].slice(-limit);
}

export function parseCrashes(raw: unknown): CrashEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CrashEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { at, source, process, reason, exitCode } = item as Record<string, unknown>;
    if (typeof at !== "string" || typeof process !== "string" || typeof reason !== "string")
      continue;
    if (source !== "renderer" && source !== "child" && source !== "gpu") continue;
    out.push({
      at,
      source,
      process,
      reason,
      exitCode: typeof exitCode === "number" ? exitCode : null,
    });
  }
  return out.slice(-CRASH_LIMIT);
}
