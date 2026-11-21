import { createHash, randomUUID } from "node:crypto";
import { parseClock } from "@shared/quiet-hours.ts";
import type { LocaleSetting } from "./i18n.ts";
import { DEFAULT_QUIET_HOURS, type QuietHours } from "./quiet-hours.ts";
import { normalizeServerAddress, safeServerPath } from "./server-address.ts";

export interface Profile {
  id: string;
  label: string;
  serverOrigin: string;
  serverVersion: string | null;
  deviceId: string;
  installationId: string | null;
  cockpitPath: string | null;
  feedbackPath: string | null;
  lastEventId: string | null;
  notifiedIds: string[];
  baselineDone: boolean;
}

export interface Settings {
  locale: LocaleSetting;
  launchAtLogin: boolean;
  pauseUntil: number | null;
  quietHours: QuietHours;
  notifications: boolean;
  shareDiagnostics: boolean;
  notificationsAsked: boolean;
  diagnosticsAsked: boolean;
}

export interface StoreData {
  version: 1;
  activeProfileId: string | null;
  profiles: Profile[];
  settings: Settings;
}

export const NOTIFIED_IDS_LIMIT = 500;

export function defaultSettings(): Settings {
  return {
    locale: "system",
    launchAtLogin: false,
    pauseUntil: null,
    quietHours: { ...DEFAULT_QUIET_HOURS },
    notifications: true,
    shareDiagnostics: false,
    notificationsAsked: false,
    diagnosticsAsked: false,
  };
}

export function emptyStore(): StoreData {
  return { version: 1, activeProfileId: null, profiles: [], settings: defaultSettings() };
}

export function profileIdFor(serverOrigin: string): string {
  return createHash("sha256").update(serverOrigin).digest("hex").slice(0, 16);
}

export function profileLabel(serverOrigin: string): string {
  try {
    return new URL(serverOrigin).host;
  } catch {
    return serverOrigin;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

const DEVICE_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function deviceIdOr(value: unknown, create: () => string = randomUUID): string {
  return typeof value === "string" && DEVICE_ID.test(value) ? value.toLowerCase() : create();
}

function parseProfile(raw: unknown): Profile | null {
  const item = record(raw);
  const address = normalizeServerAddress(
    typeof item?.serverOrigin === "string" ? item.serverOrigin : "",
  );
  if (!item || !address.ok) return null;
  const cockpitPath = safeServerPath(item.cockpitPath, "");
  const feedbackPath = safeServerPath(item.feedbackPath, "");
  const ids = Array.isArray(item.notifiedIds) ? item.notifiedIds : [];
  return {
    id: profileIdFor(address.origin),
    label: text(item.label, 120) ?? profileLabel(address.origin),
    serverOrigin: address.origin,
    serverVersion: text(item.serverVersion, 40),
    deviceId: deviceIdOr(item.deviceId),
    installationId: text(item.installationId, 64),
    cockpitPath: cockpitPath || null,
    feedbackPath: feedbackPath || null,
    lastEventId: text(item.lastEventId, 64),
    notifiedIds: ids
      .filter((id): id is string => typeof id === "string" && id.length <= 256)
      .slice(-NOTIFIED_IDS_LIMIT),
    baselineDone: item.baselineDone === true,
  };
}

function asked(value: unknown, earlierInstall: boolean): boolean {
  return typeof value === "boolean" ? value : earlierInstall;
}

const ANSWERED = { notificationsAsked: true, diagnosticsAsked: true };

export function parseSettings(raw: unknown, earlierInstall = false): Settings {
  const item = record(raw);
  const defaults = defaultSettings();
  if (!item) return { ...defaults, ...(earlierInstall ? ANSWERED : {}) };
  const quiet = record(item.quietHours);
  return {
    locale: item.locale === "de" || item.locale === "en" ? item.locale : "system",
    launchAtLogin: item.launchAtLogin === true,
    pauseUntil:
      typeof item.pauseUntil === "number" && Number.isFinite(item.pauseUntil)
        ? item.pauseUntil
        : null,
    quietHours: {
      enabled: quiet?.enabled === true,
      start: parseClock(quiet?.start) === null ? defaults.quietHours.start : String(quiet?.start),
      end: parseClock(quiet?.end) === null ? defaults.quietHours.end : String(quiet?.end),
    },
    notifications: item.notifications !== false,
    shareDiagnostics: item.shareDiagnostics === true,
    notificationsAsked: asked(item.notificationsAsked, earlierInstall),
    diagnosticsAsked: asked(item.diagnosticsAsked, earlierInstall),
  };
}

export function parseStore(raw: unknown): StoreData {
  const root = record(raw);
  if (!root) return emptyStore();
  const profiles: Profile[] = [];
  for (const entry of Array.isArray(root.profiles) ? root.profiles : []) {
    const profile = parseProfile(entry);
    if (profile && !profiles.some((known) => known.id === profile.id)) profiles.push(profile);
  }
  const active = typeof root.activeProfileId === "string" ? root.activeProfileId : null;
  return {
    version: 1,
    activeProfileId: profiles.some((profile) => profile.id === active)
      ? active
      : (profiles[0]?.id ?? null),
    profiles,
    settings: parseSettings(root.settings, profiles.length > 0),
  };
}

export function findProfile(data: StoreData, id: string | null): Profile | null {
  return data.profiles.find((profile) => profile.id === id) ?? null;
}

export function activeProfile(data: StoreData): Profile | null {
  return findProfile(data, data.activeProfileId);
}

export function upsertProfile(
  data: StoreData,
  serverOrigin: string,
  patch: Partial<Omit<Profile, "id" | "serverOrigin" | "deviceId">> = {},
  newDeviceId?: string,
): StoreData {
  const id = profileIdFor(serverOrigin);
  const existing = findProfile(data, id);
  const base: Profile = existing ?? {
    id,
    label: profileLabel(serverOrigin),
    serverOrigin,
    serverVersion: null,
    deviceId: deviceIdOr(newDeviceId),
    installationId: null,
    cockpitPath: null,
    feedbackPath: null,
    lastEventId: null,
    notifiedIds: [],
    baselineDone: false,
  };
  const next: Profile = { ...base, ...patch, id, serverOrigin, deviceId: base.deviceId };
  next.notifiedIds = next.notifiedIds.slice(-NOTIFIED_IDS_LIMIT);
  return {
    ...data,
    profiles: existing
      ? data.profiles.map((profile) => (profile.id === id ? next : profile))
      : [...data.profiles, next],
  };
}

export function signOutProfile(data: StoreData, id: string): StoreData {
  const profile = findProfile(data, id);
  if (!profile) return data;
  return upsertProfile(data, profile.serverOrigin, {
    installationId: null,
    cockpitPath: null,
    lastEventId: null,
    notifiedIds: [],
    baselineDone: false,
  });
}

export function isPendingProfile(profile: Profile): boolean {
  return profile.installationId === null && profile.serverVersion === null;
}

export function dropPendingProfiles(data: StoreData): StoreData {
  const profiles = data.profiles.filter((profile) => !isPendingProfile(profile));
  if (profiles.length === data.profiles.length) return data;
  return {
    ...data,
    profiles,
    activeProfileId: profiles.some((profile) => profile.id === data.activeProfileId)
      ? data.activeProfileId
      : (profiles[0]?.id ?? null),
  };
}

export function removeProfile(data: StoreData, id: string): StoreData {
  const profiles = data.profiles.filter((profile) => profile.id !== id);
  return {
    ...data,
    profiles,
    activeProfileId: data.activeProfileId === id ? (profiles[0]?.id ?? null) : data.activeProfileId,
  };
}

export function isSignedIn(profile: Profile | null): profile is Profile & { cockpitPath: string } {
  return Boolean(profile?.installationId && profile.cockpitPath);
}
