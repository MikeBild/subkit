// ~/.subkit/config.json load / save helpers.
//
// Multi-profile config — same shape as the sk CLI (~/.sk/config.json).
// Supports a backward-compatible migration from the legacy flat format
// { engine_url, api_key, active_tenant_id } → wrapped as the "default" profile.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Profile {
  engine_url: string;
  api_key: string;
  active_tenant_id: string | null;
}

export interface SubkitConfig {
  active_profile: string;
  profiles: Record<string, Profile>;
}

export interface ResolvedProfile extends Profile {
  name: string;
}

export const DEFAULT_ENGINE_URL = "http://localhost:3000";
export const DEFAULT_PROFILE = "default";

export function defaultProfile(): Profile {
  return {
    engine_url: DEFAULT_ENGINE_URL,
    api_key: "",
    active_tenant_id: null,
  };
}

export function defaultConfig(): SubkitConfig {
  return {
    active_profile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: defaultProfile() },
  };
}

export function configDir(): string {
  return join(homedir(), ".subkit");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(path: string = configPath()): SubkitConfig {
  if (!existsSync(path)) return defaultConfig();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SubkitConfig> & Partial<Profile>;
    // Accept the legacy single-profile layout and auto-migrate.
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

export function saveConfig(cfg: SubkitConfig, path: string = configPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore on platforms without chmod */
  }
}

export interface ResolveOptions {
  engine_url?: string | undefined;
  api_key?: string | undefined;
  tenant?: string | undefined;
  profile?: string | undefined;
  path?: string | undefined;
}

/**
 * Resolve the effective profile. Precedence:
 *   1. CLI flags (--engine-url, --api-key, --tenant, --profile)
 *   2. Environment variables (SUBKIT_ENGINE_URL, SUBKIT_API_KEY, SUBKIT_TENANT, SUBKIT_PROFILE)
 *   3. On-disk profile fields
 *   4. Defaults
 */
export function resolveProfile(opts: ResolveOptions = {}): ResolvedProfile {
  const disk = loadConfig(opts.path ?? configPath());
  const profileName =
    opts.profile?.trim() ||
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
  return { name: profileName, engine_url, api_key, active_tenant_id };
}

/** Persist an updated profile back to disk under its current name. */
export function saveProfile(updates: ResolvedProfile, path: string = configPath()): void {
  const disk = loadConfig(path);
  disk.active_profile = updates.name;
  disk.profiles[updates.name] = {
    engine_url: updates.engine_url,
    api_key: updates.api_key,
    active_tenant_id: updates.active_tenant_id,
  };
  saveConfig(disk, path);
}

// Backward-compat wrapper — resolves a single flat config from the active profile.
export function resolveConfig(opts: Omit<ResolveOptions, "profile"> = {}): ResolvedProfile {
  return resolveProfile(opts);
}
