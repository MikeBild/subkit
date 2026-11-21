import {
  type SettingItem,
  type SettingsView,
  settingSecretStored,
  settingSectionOf,
  settingsViewFromUrl,
} from "@/pages/settings-model";

export const PERSONAL_AREA_IDS = [
  "profile",
  "setup",
  "people",
  "devices",
  "updates",
  "privacy",
  "rules",
  "workspace",
  "help",
] as const;
export type PersonalAreaId = (typeof PERSONAL_AREA_IDS)[number];

export const ENGINE_AREA_IDS = [
  "ai",
  "access",
  "connections",
  "notifications",
  "operations",
] as const;
export type EngineAreaId = (typeof ENGINE_AREA_IDS)[number];

export const SETTING_AREA_IDS = [
  "profile",
  "setup",
  "people",
  "notifications",
  "devices",
  "updates",
  "privacy",
  "rules",
  "workspace",
  "ai",
  "access",
  "connections",
  "operations",
  "help",
] as const satisfies readonly (PersonalAreaId | EngineAreaId)[];
export type SettingAreaId = (typeof SETTING_AREA_IDS)[number];

export function isPersonalArea(area: SettingAreaId): area is PersonalAreaId {
  return (PERSONAL_AREA_IDS as readonly string[]).includes(area);
}

export const SETTING_AREAS: readonly { id: EngineAreaId; sections: readonly string[] }[] = [
  { id: "ai", sections: ["llm", "tokens"] },
  { id: "access", sections: ["auth", "products", "mcp", "egress", "spec"] },
  { id: "connections", sections: ["connectors", "platform", "storage"] },
  { id: "notifications", sections: ["notifications"] },
  {
    id: "operations",
    sections: [
      "server",
      "database",
      "log",
      "errors",
      "operations",
      "observability",
      "queue",
      "sandbox",
      "repl",
      "ui",
    ],
  },
];

function isSettingArea(value: string | null | undefined): value is SettingAreaId {
  return SETTING_AREA_IDS.includes(value as SettingAreaId);
}

function settingAreaOfSection(section: string): EngineAreaId {
  return SETTING_AREAS.find((area) => area.sections.includes(section))?.id ?? "operations";
}

export function settingAreaOf(path: string): EngineAreaId {
  return settingAreaOfSection(settingSectionOf(path));
}

export type SettingsLevel =
  | { kind: "area"; area: SettingAreaId }
  | { kind: "all"; view: SettingsView };

export const FIRST_SETTINGS_LEVEL: SettingsLevel = { kind: "area", area: "profile" };

export function settingsLevelFromUrl(search: string): SettingsLevel {
  const params = new URLSearchParams(search);
  const area = params.get("area");
  if (isSettingArea(area)) return { kind: "area", area };
  const view = settingsViewFromUrl(search);
  if (
    view.leaf ||
    view.section ||
    params.get("filter") === "changed" ||
    params.get("view") === "all"
  )
    return { kind: "all", view };
  if (params.get("tab") === "notifications") return { kind: "area", area: "notifications" };
  return FIRST_SETTINGS_LEVEL;
}

export interface SettingsAccess {
  permissions: readonly string[];
  isOwner: boolean;
  origin: "self_hosted" | "self_service";
}

export type EngineSettingsAccess = "write" | "read" | "none";

export function engineSettingsAccess(access: SettingsAccess): EngineSettingsAccess {
  if (access.permissions.includes("settings:write:global")) return "write";
  return access.origin === "self_hosted" && access.permissions.includes("settings:read")
    ? "read"
    : "none";
}

function administersWorkspace(access: SettingsAccess): boolean {
  return access.isOwner || access.permissions.includes("identity:write");
}

export function workspaceAiEditable(access: SettingsAccess): boolean {
  return (
    access.origin === "self_service" &&
    engineSettingsAccess(access) === "none" &&
    administersWorkspace(access)
  );
}

export function visibleSettingAreas(access: SettingsAccess, desktop = false): SettingAreaId[] {
  const engine = engineSettingsAccess(access) !== "none";
  return SETTING_AREA_IDS.filter((area) => {
    if (area === "updates" || area === "privacy") return desktop;
    if (
      area === "profile" ||
      area === "setup" ||
      area === "rules" ||
      area === "devices" ||
      area === "help"
    )
      return true;
    if (area === "people")
      return ["identity:read", "rbac:read", "settings:read"].some((permission) =>
        access.permissions.includes(permission),
      );
    if (area === "workspace") return administersWorkspace(access);
    if (area === "ai") return engine || workspaceAiEditable(access);
    if (area === "notifications") return engine || access.permissions.includes("notification:read");
    return engine;
  });
}

export function openSettingsLevel(
  level: SettingsLevel,
  access: SettingsAccess,
  desktop = false,
): SettingsLevel {
  if (level.kind === "all")
    return engineSettingsAccess(access) === "none" ? FIRST_SETTINGS_LEVEL : level;
  if (!visibleSettingAreas(access, desktop).includes(level.area)) return FIRST_SETTINGS_LEVEL;
  return level;
}

export const SCOPED_AREAS = ["ai"] as const;
export type ScopedArea = (typeof SCOPED_AREAS)[number];

const SCOPED_SECTION: Readonly<Record<ScopedArea, string>> = { ai: "llm" };

export function scopedAreaOf(level: SettingsLevel): ScopedArea | null {
  return level.kind === "area" && (SCOPED_AREAS as readonly string[]).includes(level.area)
    ? (level.area as ScopedArea)
    : null;
}

function workspaceHasOwnValue(
  area: ScopedArea,
  tenantItems: readonly SettingItem[] | null,
): boolean {
  return (tenantItems ?? []).some(
    (item) => item.meta.source === "tenant" && settingSectionOf(item.path) === SCOPED_SECTION[area],
  );
}

export function pageScope(
  level: SettingsLevel,
  scopeAvailable: boolean,
  chosen: Readonly<Partial<Record<ScopedArea, "global" | "tenant">>>,
  tenantItems: readonly SettingItem[] | null,
): "global" | "tenant" {
  const area = scopedAreaOf(level);
  if (!scopeAvailable || !area) return "global";
  return chosen[area] ?? (workspaceHasOwnValue(area, tenantItems) ? "tenant" : "global");
}

export type AreaStatus = "configured" | "waiting" | "restart" | "nameMissing";

interface AreaFacts {
  items: readonly SettingItem[];
  pendingRestart: readonly string[];
}

function itemValue(items: readonly SettingItem[], path: string): unknown {
  return items.find((item) => item.path === path)?.value;
}

function stringValue(items: readonly SettingItem[], path: string): string {
  const value = itemValue(items, path);
  return typeof value === "string" ? value : "";
}

export function providerKeyPath(provider: string): string {
  return `llm.providers.${provider}.api_key`;
}

function providerKeyState(
  items: readonly SettingItem[],
  provider: string,
  primary: boolean,
): "stored" | "missing" | "none" {
  const key = items.find((item) => item.path === providerKeyPath(provider));
  if (!key) return "none";
  if (settingSecretStored(key)) return "stored";
  const generalKey = primary ? items.find((item) => item.path === "llm.api_key") : undefined;
  return generalKey && settingSecretStored(generalKey) ? "stored" : "missing";
}

function areaRestartFields(area: EngineAreaId, pending: readonly string[]): string[] {
  return pending.filter((path) => settingAreaOf(path) === area);
}

export function areaStatus(area: EngineAreaId, facts: AreaFacts): AreaStatus | null {
  const restart =
    area === "operations" ? facts.pendingRestart : areaRestartFields(area, facts.pendingRestart);
  if (restart.length > 0) return "restart";
  if (area === "ai") {
    const provider = stringValue(facts.items, "llm.provider");
    if (!provider) return "waiting";
    if (provider === "mock") return "configured";
    return providerKeyState(facts.items, provider, true) === "missing" ? "waiting" : "configured";
  }
  return null;
}

const CHAT_PLATFORMS: readonly { id: string; secret: string; name: string }[] = [
  { id: "slack", secret: "platform.slack.signing_secret", name: "Slack" },
  { id: "googlechat", secret: "platform.googlechat.private_key", name: "Google Chat" },
];

export function connectedChatPlatforms(items: readonly SettingItem[]) {
  return CHAT_PLATFORMS.map((platform) => {
    const secret = items.find((item) => item.path === platform.secret);
    return { ...platform, connected: secret ? settingSecretStored(secret) : false };
  });
}

export function ownObjectStore(items: readonly SettingItem[]): boolean {
  return stringValue(items, "storage.object_store.bucket").length > 0;
}

export function settingsGuidedErrors(
  items: readonly SettingItem[],
  drafts: Readonly<Record<string, string>>,
): string[] {
  const effective = (path: string) => drafts[path] ?? stringValue(items, path);
  return Object.entries(drafts).flatMap(([path, text]) =>
    path === "llm.fallback_provider" && text !== "" && text === effective("llm.provider")
      ? [path]
      : [],
  );
}
