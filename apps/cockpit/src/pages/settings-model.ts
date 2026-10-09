import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import { sameJsonValue as sameSettingValue } from "@/lib/json-value";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export interface SettingItem {
  path: string;
  value: unknown;
  meta: {
    source: string;
    scope: string;
    sensitive: boolean;
    requiresRestart: boolean;
    description?: string;
    kind: string;
    default?: unknown;
    enum_values?: string[];
  };
}

export interface SettingsResponse {
  saved_revision: number | null;
  active_revision: number | null;
  activation_status: "saved" | "preparing" | "active" | "failed" | "restart_required" | null;
  pending_restart_fields: string[];
  items: SettingItem[];
  diagnostics: {
    pending_restart_keys: string[];
    override_keys: string[];
  };
}

const SETTING_META_KEYS: Readonly<Record<string, TranslationKey>> = {
  default: "settings.meta.default",
  env: "settings.meta.environment",
  environment: "settings.meta.environment",
  global: "settings.meta.global",
  tenant: "settings.meta.workspace",
  override: "settings.meta.override",
  workspace: "settings.meta.workspace",
};

export function settingMetaLabel(value: string, t: Translate): CatalogLabel {
  return catalogLabel(value, SETTING_META_KEYS[value.toLowerCase()], t);
}

export function settingSourceIsNotable(source: string): boolean {
  return !["global", "default"].includes(source.toLowerCase());
}

export function settingAppliesToShown(
  meta: Pick<SettingItem["meta"], "scope" | "source">,
): boolean {
  return meta.scope.toLowerCase() === "tenant" || meta.source.toLowerCase() === "tenant";
}

export function settingsLeafFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("leaf")?.trim() ?? "";
  return raw.length <= 128 && /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i.test(raw) ? raw : null;
}

export type SettingsFilter = "all" | "changed";

export interface SettingsView {
  leaf: string | null;
  section: string | null;
  filter: SettingsFilter;
}

export function settingsViewFromUrl(search: string): SettingsView {
  const params = new URLSearchParams(search);
  const section = params.get("section")?.trim() ?? "";
  return {
    leaf: settingsLeafFromUrl(search),
    section: section.length <= 64 && /^[a-z0-9_]+$/i.test(section) ? section : null,
    filter: params.get("filter") === "changed" ? "changed" : "all",
  };
}

export function settingLeafTarget(
  paths: readonly string[],
  leaf: string,
): { index: number; kind: "leaf" | "group" } | null {
  const exact = paths.indexOf(leaf);
  if (exact >= 0) return { index: exact, kind: "leaf" };
  const first = paths.findIndex((path) => path.startsWith(`${leaf}.`));
  return first >= 0 ? { index: first, kind: "group" } : null;
}

export function settingSectionOf(path: string): string {
  return path.split(".")[0] || "other";
}

export function settingLabel(path: string, t: Translate): CatalogLabel {
  const key = `settings.leaf.${path}`;
  return Object.hasOwn(CATALOGS.en, key)
    ? { text: t(key as TranslationKey), machine: false }
    : { text: path, machine: true };
}

export const SETTING_SECTION_KEYS: Readonly<Record<string, TranslationKey>> = {
  auth: "settings.section.auth",
  connectors: "settings.section.connectors",
  database: "settings.section.database",
  egress: "settings.section.egress",
  errors: "settings.section.errors",
  llm: "settings.section.llm",
  log: "settings.section.log",
  mcp: "settings.section.mcp",
  notifications: "settings.section.notifications",
  observability: "settings.section.observability",
  operations: "settings.section.operations",
  platform: "settings.section.platform",
  queue: "settings.section.queue",
  repl: "settings.section.repl",
  sandbox: "settings.section.sandbox",
  server: "settings.section.server",
  spec: "settings.section.spec",
  storage: "settings.section.storage",
  tokens: "settings.section.tokens",
  ui: "settings.section.ui",
};

export function settingSectionLabel(section: string, t: Translate): CatalogLabel {
  return catalogLabel(section, SETTING_SECTION_KEYS[section], t);
}

export type SettingGroupId =
  | "ai"
  | "access"
  | "integrations"
  | "execution"
  | "sk"
  | "operations"
  | "other";

export const SETTING_GROUPS: readonly {
  id: Exclude<SettingGroupId, "other">;
  label: TranslationKey;
  sections: readonly string[];
}[] = [
  { id: "ai", label: "settings.group.ai", sections: ["llm", "tokens"] },
  { id: "access", label: "settings.group.access", sections: ["auth", "mcp", "egress", "spec"] },
  {
    id: "integrations",
    label: "settings.group.integrations",
    sections: ["connectors", "platform", "storage"],
  },
  { id: "execution", label: "settings.group.execution", sections: ["queue", "sandbox"] },
  { id: "sk", label: "settings.group.sk", sections: ["repl", "ui", "notifications"] },
  {
    id: "operations",
    label: "settings.group.operations",
    sections: ["server", "database", "log", "errors", "operations", "observability"],
  },
];

export interface SettingNavGroup {
  id: SettingGroupId;
  label: TranslationKey;
  sections: string[];
}

export function settingNavigation(present: readonly string[]): SettingNavGroup[] {
  const have = new Set(present);
  const placed = new Set(SETTING_GROUPS.flatMap((group) => group.sections));
  const groups: SettingNavGroup[] = SETTING_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    sections: group.sections.filter((section) => have.has(section)),
  })).filter((group) => group.sections.length > 0);
  const unplaced = [...have].filter((section) => !placed.has(section));
  if (unplaced.length > 0)
    groups.push({ id: "other", label: "settings.group.other", sections: unplaced });
  return groups;
}

export interface SettingsAttention {
  restart: string[];
  notActivated: boolean;
}

export function settingsAttention(
  data: Pick<SettingsResponse, "pending_restart_fields" | "activation_status"> | undefined,
): SettingsAttention | null {
  if (!data) return null;
  const restart = data.pending_restart_fields ?? [];
  const notActivated = data.activation_status === "failed";
  return restart.length > 0 || notActivated ? { restart, notActivated } : null;
}

export function isUnset(item: Pick<SettingItem, "value">): boolean {
  return item.value === null || item.value === undefined;
}

export function settingFieldValue(
  item: Pick<SettingItem, "value" | "meta">,
  draft: string | undefined,
): string {
  if (draft !== undefined) return draft;
  if (item.meta.sensitive || isUnset(item)) return "";
  return typeof item.value === "string" ? item.value : JSON.stringify(item.value);
}

export { sameJsonValue as sameSettingValue } from "@/lib/json-value";

export function settingHasDefault(item: Pick<SettingItem, "meta">): boolean {
  return Object.hasOwn(item.meta, "default");
}

export function settingSecretStored(item: Pick<SettingItem, "value" | "meta">): boolean {
  return item.meta.sensitive && !isUnset(item) && item.value !== "";
}

export function settingSecretCover(
  item: Pick<SettingItem, "path" | "value" | "meta">,
  items: readonly SettingItem[],
): string | null {
  if (item.path !== "llm.api_key" || settingSecretStored(item)) return null;
  const provider = items.find((entry) => entry.path === "llm.provider")?.value;
  if (typeof provider !== "string" || !provider) return null;
  const path = `llm.providers.${provider}.api_key`;
  const cover = items.find((entry) => entry.path === path);
  return cover && settingSecretStored(cover) ? path : null;
}

export function settingIsChanged(item: SettingItem): boolean {
  if (item.meta.sensitive) return settingSecretStored(item);
  if (!settingHasDefault(item)) return false;
  return !sameSettingValue(item.value, item.meta.default);
}

export function settingDraftText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isNumberSetting(item: Pick<SettingItem, "value" | "meta">): boolean {
  return item.meta.kind === "number" || typeof item.value === "number";
}

export function parseSettingDraft(item: Pick<SettingItem, "value" | "meta">, raw: string): unknown {
  const kind = item.meta.kind;
  if (kind === "boolean" || typeof item.value === "boolean") return raw === "true";
  if (isNumberSetting(item)) {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : undefined;
  }
  if (kind === "enum") return raw === "" ? null : raw;
  if (
    kind === "json" ||
    kind === "string-list" ||
    kind === "string-array" ||
    Array.isArray(item.value) ||
    (item.value !== null && typeof item.value === "object")
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return raw;
}

export function settingDraftError(
  item: Pick<SettingItem, "value" | "meta">,
  raw: string | undefined,
): "settings.invalidNumber" | "settings.invalidJson" | null {
  if (raw === undefined || item.meta.sensitive) return null;
  if (parseSettingDraft(item, raw) !== undefined) return null;
  return isNumberSetting(item) ? "settings.invalidNumber" : "settings.invalidJson";
}

export function settingDiffersFromDefault(item: SettingItem, draft: string | undefined): boolean {
  if (item.meta.sensitive || !settingHasDefault(item)) return false;
  const value = draft === undefined ? item.value : parseSettingDraft(item, draft);
  return value === undefined || !sameSettingValue(value, item.meta.default);
}

export function settingResetDraft(item: SettingItem): string | null {
  if (item.meta.sensitive || !settingHasDefault(item)) return null;
  return settingDraftText(item.meta.default);
}

export function settingValueText(value: unknown, t: Translate): string {
  if (value === null || value === undefined) return t("settings.unset");
  if (typeof value === "boolean") return t(value ? "settings.value.on" : "settings.value.off");
  if (value === "" || (Array.isArray(value) && value.length === 0))
    return t("settings.value.empty");
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function settingUnit(path: string): TranslationKey | null {
  const leaf = path.split(".").pop() ?? "";
  if (path === "tokens.monthly_budget") return "settings.unit.tokens";
  if (/_ms$|Ms$/.test(leaf)) return "settings.unit.ms";
  if (/_seconds$|Sec$/.test(leaf)) return "settings.unit.seconds";
  if (/_minutes$|Min$/.test(leaf)) return "settings.unit.minutes";
  if (/_days$/.test(leaf)) return "settings.unit.days";
  if (/_bytes$|_byte_cap$/.test(leaf)) return "settings.unit.bytes";
  if (/_pct$/.test(leaf)) return "settings.unit.percent";
  if (/_chars(_|$)/.test(leaf)) return "settings.unit.chars";
  return null;
}

export function settingHelpKey(path: string): TranslationKey | null {
  const key = `settings.help.${path}`;
  return Object.hasOwn(CATALOGS.en, key) ? (key as TranslationKey) : null;
}

export interface SettingsPatch {
  expected_revision: number;
  changes: Record<string, unknown>;
  scope: "global";
}

export function settingsPatch(
  data: Pick<SettingsResponse, "saved_revision" | "items">,
  drafts: Readonly<Record<string, string>>,
  secretReferences: Readonly<Record<string, string>>,
): SettingsPatch {
  if (data.saved_revision === null) throw new Error("settings have no saved revision to build on");
  const changes: Record<string, unknown> = {};
  for (const item of data.items) {
    if (!Object.hasOwn(drafts, item.path)) continue;
    if (item.meta.sensitive) {
      const reference = secretReferences[item.path];
      if (!reference) throw new Error(`secret ${item.path} has no stored version`);
      changes[item.path] = reference;
      continue;
    }
    const value = parseSettingDraft(item, drafts[item.path] ?? "");
    if (value === undefined) throw new Error(`draft for ${item.path} is not a valid value`);
    changes[item.path] = value;
  }
  return { expected_revision: data.saved_revision, changes, scope: "global" };
}

export function settingsActivationPath(saved: { saved_revision: number }): string {
  return `/v1/settings/revisions/${saved.saved_revision}/activate`;
}

export function settingSecretName(path: string): string {
  return `settings.${path}`;
}

export function settingsSaveFailure(error: unknown): "conflict" | "failed" {
  return (error as { status?: unknown } | null)?.status === 409 ? "conflict" : "failed";
}
