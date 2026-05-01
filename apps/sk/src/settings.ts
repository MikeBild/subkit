// Layered settings loader for the `sk` CLI.
//
// Read order (later wins):
//
//   1. `~/.sk/settings.json`                (user)
//   2. `<repo>/.sk/settings.json`           (project, walked upward from cwd)
//   3. `<cwd>/.sk/settings.local.json`      (local overrides, git-ignored)
//
// Unknown keys are preserved but not validated — the schema is open
// to extension so we can land new features without teaching every
// user to update their files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SkSettings {
  model?: string;
  defaultTenant?: string;
  additionalDirectories?: string[];
  /**
   * Status line configuration — mirrors Claude Code's
   * `statusLine` hook. Provide `command` to run a shell
   * command with a JSON input on stdin; its stdout becomes
   * the line. Provide `format` as a fallback template that's
   * rendered locally when no command is set. `refreshMs`
   * controls how often the line rebuilds in the REPL
   * (defaults to 500ms).
   */
  statusLine?: {
    /** Shell command to execute. Receives StatusLineInput JSON on stdin. */
    command?: string;
    /**
     * Local template used when `command` is absent. Placeholders:
     * `{persona}`, `{tenant}`, `{model}`, `{engine_url}`,
     * `{session_id}`, `{turn_tokens}`, `{remaining_tokens}`,
     * `{cwd}`, `{git_branch}`. Unknown placeholders expand to "".
     */
    format?: string;
    showCost?: boolean;
    showTokens?: boolean;
    showPersona?: boolean;
    /** Minimum milliseconds between hook invocations. */
    refreshMs?: number;
  };
  mcpServers?: Record<string, { url?: string; command?: string; args?: string[] }>;
  includeMemoryFile?: boolean;
  maxInlineMentionBytes?: number;
  headless?: { maxTurns?: number; maxBudgetTokens?: number };
}

const DEFAULTS: SkSettings = {
  statusLine: { showTokens: true, showPersona: true, showCost: false },
  includeMemoryFile: true,
  maxInlineMentionBytes: 262144,
};

export interface LoadSettingsResult {
  merged: SkSettings;
  /** File paths actually read, in merge order. */
  sources: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function userSettingsPath(): string {
  return join(homedir(), ".sk", "settings.json");
}

export function saveUserSettingsPatch(patch: SkSettings): string {
  const path = userSettingsPath();
  const current = readJson(path) ?? {};
  const next = deepMerge(current as SkSettings, patch);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return path;
}

function findProjectSettings(cwd: string): string | null {
  // Walk upward from cwd looking for a `.sk/settings.json`. Stops at
  // filesystem root or the home dir (whichever comes first).
  const home = homedir();
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, ".sk", "settings.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    if (dir === home) break;
    dir = parent;
  }
  return null;
}

function deepMerge<T>(a: T, b: T): T {
  if (a === undefined || a === null) return b;
  if (b === undefined || b === null) return a;
  if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) {
    return b;
  }
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    out[k] = deepMerge((a as Record<string, unknown>)[k] as unknown, v);
  }
  return out as T;
}

export function loadSettings(cwd: string = process.cwd()): LoadSettingsResult {
  const sources: string[] = [];
  let merged: SkSettings = { ...DEFAULTS };

  const userPath = userSettingsPath();
  const userJson = readJson(userPath);
  if (userJson) {
    sources.push(userPath);
    merged = deepMerge(merged, userJson as SkSettings);
  }

  const projectPath = findProjectSettings(cwd);
  if (projectPath) {
    const projJson = readJson(projectPath);
    if (projJson) {
      sources.push(projectPath);
      merged = deepMerge(merged, projJson as SkSettings);
    }
  }

  const localPath = join(cwd, ".sk", "settings.local.json");
  const localJson = readJson(localPath);
  if (localJson) {
    sources.push(localPath);
    merged = deepMerge(merged, localJson as SkSettings);
  }

  return { merged, sources };
}
