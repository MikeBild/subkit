// `~/.sk/config.json` — multi-profile config for the `sk` end-user CLI.
//
// The `sk` config supports multiple named profiles up-front; switching
// profiles is a single flag (`--profile <name>`) or the active one via
// `/tenant` at runtime. A single legacy profile layout is also accepted
// for interoperability when an operator imports their `~/.subkit/config.json`.
//
// runDeviceFlow + readSse + the TurnEvent reducer live under
// packages/cli-core (@cli-core/*) and are imported by the shared `sk`
// CLI surfaces.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Profile {
  engine_url: string;
  api_key: string;
  active_tenant_id: string | null;
  /**
   * Cached for status-line rendering only — not authoritative.
   * Always overridden by RBAC probe results on startup.
   */
  persona_hint?: "admin" | "operator" | "member" | "enduser" | "portal" | null;
  /** Locked to true for profiles authenticated via a portal token. */
  portal_locked?: boolean;
}

export interface SkConfig {
  active_profile: string;
  profiles: Record<string, Profile>;
}

// Matches the engine's default port (.env → PORT=3000). Override via
// --engine-url or SUBKIT_ENGINE_URL when talking to a remote engine.
export const DEFAULT_ENGINE_URL = "http://localhost:3000";
export const DEFAULT_PROFILE = "default";

export function defaultProfile(): Profile {
  return {
    engine_url: DEFAULT_ENGINE_URL,
    api_key: "",
    active_tenant_id: null,
  };
}

export function defaultConfig(): SkConfig {
  return {
    active_profile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: defaultProfile() },
  };
}

export function configDir(): string {
  return join(homedir(), ".sk");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(path: string = configPath()): SkConfig {
  if (!existsSync(path)) return defaultConfig();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SkConfig> & Partial<Profile>;
    // Accept a legacy single-profile shape too.
    if (!parsed.profiles && (parsed.engine_url || parsed.api_key)) {
      return {
        active_profile: DEFAULT_PROFILE,
        profiles: {
          [DEFAULT_PROFILE]: {
            engine_url: parsed.engine_url ?? DEFAULT_ENGINE_URL,
            api_key: parsed.api_key ?? "",
            active_tenant_id: parsed.active_tenant_id ?? null,
          },
        },
      };
    }
    const active_profile = parsed.active_profile ?? DEFAULT_PROFILE;
    const profiles = parsed.profiles ?? { [active_profile]: defaultProfile() };
    return { active_profile, profiles };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cfg: SkConfig, path: string = configPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows / non-unix: no-op */
  }
}

export interface ResolvedProfile extends Profile {
  name: string;
}

export interface ResolveOptions {
  engine_url?: string | undefined;
  api_key?: string | undefined;
  tenant?: string | undefined;
  profile?: string | undefined;
  path?: string | undefined;
}

/**
 * Resolve the effective profile for this invocation. Precedence:
 *
 *   1. CLI flags (`--engine-url`, `--api-key`, `--tenant`, `--profile`)
 *   2. Environment variables (`SUBKIT_ENGINE_URL`, `SUBKIT_API_KEY`,
 *      `SUBKIT_TENANT`, `SUBKIT_PROFILE` or `SK_PROFILE`)
 *   3. On-disk profile fields (from the selected profile)
 *   4. Defaults
 */
export function resolveProfile(opts: ResolveOptions = {}): ResolvedProfile {
  const disk = loadConfig(opts.path ?? configPath());
  const profileName =
    opts.profile?.trim() ||
    process.env.SK_PROFILE?.trim() ||
    process.env.SUBKIT_PROFILE?.trim() ||
    disk.active_profile ||
    DEFAULT_PROFILE;
  const diskProfile = disk.profiles[profileName] ?? defaultProfile();
  const engine_url =
    opts.engine_url?.trim() ||
    process.env.SUBKIT_ENGINE_URL?.trim() ||
    diskProfile.engine_url ||
    DEFAULT_ENGINE_URL;
  const api_key =
    opts.api_key?.trim() || process.env.SUBKIT_API_KEY?.trim() || diskProfile.api_key || "";
  const active_tenant_id =
    opts.tenant?.trim() ||
    process.env.SUBKIT_TENANT?.trim() ||
    diskProfile.active_tenant_id ||
    null;
  return {
    name: profileName,
    engine_url,
    api_key,
    active_tenant_id,
    ...(diskProfile.persona_hint ? { persona_hint: diskProfile.persona_hint } : {}),
    ...(diskProfile.portal_locked ? { portal_locked: diskProfile.portal_locked } : {}),
  };
}

/** Persist an updated profile back to disk under its current name. */
export function saveProfile(updates: ResolvedProfile, path: string = configPath()): void {
  const disk = loadConfig(path);
  disk.active_profile = updates.name;
  disk.profiles[updates.name] = {
    engine_url: updates.engine_url,
    api_key: updates.api_key,
    active_tenant_id: updates.active_tenant_id,
    ...(updates.persona_hint ? { persona_hint: updates.persona_hint } : {}),
    ...(updates.portal_locked ? { portal_locked: updates.portal_locked } : {}),
  };
  saveConfig(disk, path);
}
