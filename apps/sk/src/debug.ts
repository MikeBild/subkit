// Debug logger for the `sk` CLI.
//
// Activation (any of):
//   - `SK_DEBUG=1` env var (or `DEBUG=sk` / `DEBUG=sk:*`)
//   - `--debug` / `-d` argv flag
//
// Activation is decided ONCE at module-load via `isDebugMode()`. The
// helpers in this module are no-ops when debug is off, so they are
// safe to call from hot paths (every HTTP request) — the cost is one
// boolean check.
//
// When active, every `debug.log({...})` call appends a single
// JSON-Lines record to `~/.sk/debug.log`. The path is exposed via
// `debugLogPath()` so the `/debug` slash command can show it and tail
// the file.

import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function envEnabled(): boolean {
  const sk = process.env.SK_DEBUG?.toLowerCase().trim();
  if (sk && TRUTHY.has(sk)) return true;
  const generic = process.env.DEBUG?.toLowerCase().trim();
  if (generic && (generic === "sk" || generic === "sk:*" || generic === "*")) return true;
  return false;
}

function argvEnabled(): boolean {
  for (const arg of process.argv) {
    if (arg === "--debug" || arg === "-d") return true;
    if (arg.startsWith("--debug=")) return true;
  }
  return false;
}

let cachedActive: boolean | null = null;

export function isDebugMode(): boolean {
  if (cachedActive !== null) return cachedActive;
  cachedActive = envEnabled() || argvEnabled();
  return cachedActive;
}

/**
 * Programmatic toggle — used by `/debug on|off` to flip mode without
 * a restart. Returns the new state.
 */
export function setDebugMode(next: boolean): boolean {
  cachedActive = next;
  return next;
}

export function debugLogPath(): string {
  const override = process.env.SK_DEBUG_FILE;
  if (override && override.length > 0) return override;
  return join(homedir(), ".sk", "debug.log");
}

interface DebugRecord {
  ts: string;
  scope: string;
  [key: string]: unknown;
}

let writeFailed = false;

function appendRecord(rec: DebugRecord): void {
  const path = debugLogPath();
  const line = `${JSON.stringify(rec)}\n`;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.appendFileSync(path, line, { encoding: "utf8" });
  } catch (err) {
    // Avoid noisy fallbacks every request when the file system is
    // misconfigured. Surface ONCE on stderr, then go silent so debug
    // never breaks the user's session.
    if (!writeFailed) {
      writeFailed = true;
      process.stderr.write(
        `sk: debug log unavailable (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  }
}

export function debugLog(scope: string, fields: Record<string, unknown>): void {
  if (!isDebugMode()) return;
  appendRecord({ ts: new Date().toISOString(), scope, ...fields });
}

/**
 * Read the tail of the debug log for `/debug tail` rendering. Returns
 * an empty array when the file does not yet exist.
 */
export function debugLogTail(maxLines = 40): string[] {
  const path = debugLogPath();
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  return lines.slice(-maxLines);
}
