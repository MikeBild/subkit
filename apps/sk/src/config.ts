import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Profile {
  engine_url: string;
  api_key: string;
  active_tenant_id: string | null;
  persona_hint?: "admin" | "operator" | "member" | "enduser" | "portal" | null;
  portal_locked?: boolean;
  notification_inbox_cursor?: number;
}

export interface SkConfig {
  active_profile: string;
  profiles: Record<string, Profile>;
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
    const parsed = JSON.parse(raw) as Partial<SkConfig>;
    const active_profile =
      typeof parsed.active_profile === "string" && parsed.active_profile.length > 0
        ? parsed.active_profile
        : DEFAULT_PROFILE;
    const rawProfiles =
      parsed.profiles && typeof parsed.profiles === "object" && !Array.isArray(parsed.profiles)
        ? parsed.profiles
        : null;
    if (!rawProfiles) return defaultConfig();
    const profiles =
      Object.keys(rawProfiles).length > 0 ? rawProfiles : { [DEFAULT_PROFILE]: defaultProfile() };
    if (!profiles[active_profile]) {
      profiles[active_profile] = defaultProfile();
    }
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
  } catch {}
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
    ...(typeof diskProfile.notification_inbox_cursor === "number"
      ? { notification_inbox_cursor: diskProfile.notification_inbox_cursor }
      : {}),
  };
}

export function getNotificationInboxCursor(
  opts: ResolveOptions = {},
  path: string = configPath(),
): number {
  const disk = loadConfig(path);
  const profileName =
    opts.profile?.trim() ||
    process.env.SK_PROFILE?.trim() ||
    process.env.SUBKIT_PROFILE?.trim() ||
    disk.active_profile ||
    DEFAULT_PROFILE;
  const cursor = disk.profiles[profileName]?.notification_inbox_cursor;
  return typeof cursor === "number" ? cursor : 0;
}

export function setNotificationInboxCursor(
  cursor: number,
  opts: ResolveOptions = {},
  path: string = configPath(),
): void {
  const disk = loadConfig(path);
  const profileName =
    opts.profile?.trim() ||
    process.env.SK_PROFILE?.trim() ||
    process.env.SUBKIT_PROFILE?.trim() ||
    disk.active_profile ||
    DEFAULT_PROFILE;
  const existing = disk.profiles[profileName] ?? defaultProfile();
  disk.profiles[profileName] = { ...existing, notification_inbox_cursor: cursor };
  saveConfig(disk, path);
}

export function saveProfile(updates: ResolvedProfile, path: string = configPath()): void {
  const disk = loadConfig(path);
  disk.active_profile = updates.name;
  const trimmedKey = updates.api_key.trim();
  disk.profiles[updates.name] = {
    engine_url: updates.engine_url,
    api_key: trimmedKey,
    active_tenant_id: updates.active_tenant_id,
    ...(updates.persona_hint ? { persona_hint: updates.persona_hint } : {}),
    ...(updates.portal_locked ? { portal_locked: updates.portal_locked } : {}),
    ...(typeof updates.notification_inbox_cursor === "number"
      ? { notification_inbox_cursor: updates.notification_inbox_cursor }
      : {}),
  };
  if (trimmedKey.length === 0) {
    delete (disk.profiles[updates.name] as { api_key?: string }).api_key;
  }
  saveConfig(disk, path);
}
