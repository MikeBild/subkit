import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SkSettings {
  model?: string;
  defaultTenant?: string;
  additionalDirectories?: string[];
  statusLine?: {
    command?: string;
    format?: string;
    showCost?: boolean;
    showTokens?: boolean;
    showPersona?: boolean;
    refreshMs?: number;
  };
  mcpServers?: Record<string, { url?: string; command?: string; args?: string[] }>;
  includeMemoryFile?: boolean;
  maxInlineMentionBytes?: number;
  headless?: { maxTurns?: number; maxBudgetTokens?: number };
  nextCommandPreviewEnabled?: boolean;
}

export const DEFAULTS: SkSettings = {
  statusLine: { showTokens: true, showPersona: true, showCost: false },
  includeMemoryFile: true,
  maxInlineMentionBytes: 262144,
  nextCommandPreviewEnabled: true,
};

export interface LoadSettingsResult {
  merged: SkSettings;
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
