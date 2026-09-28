import { CATALOGS, type TranslationKey } from "@/lib/i18n";
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

/** Where a setting's value came from, or which scope it applies to. */
export function settingMetaLabel(value: string, t: Translate): CatalogLabel {
  return catalogLabel(value, SETTING_META_KEYS[value.toLowerCase()], t);
}

/**
 * Whether a row names where its value came from. Almost every setting is the
 * installation's own value or the engine's default; a chip saying so on 145
 * rows said nothing. The chip stands only where the value comes from
 * somewhere else — the environment, this workspace, an override — and the
 * plain source stays in the row's technical details.
 */
export function settingSourceIsNotable(source: string): boolean {
  return !["global", "default"].includes(source.toLowerCase());
}

/**
 * The setting a link opens the settings page at — `server.public_base_url` —
 * or nothing. `settingsHref` in app/links.ts writes it. A leaf is a dotted
 * path of plain words; anything else could not name a setting and is dropped
 * rather than searched for.
 */
export function settingsLeafFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("leaf")?.trim() ?? "";
  return raw.length <= 128 && /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i.test(raw) ? raw : null;
}

/**
 * Everything the settings page keeps in its address: the leaf a link opened it
 * at, the section and the search. A reload or a shared link lands on the same
 * view; a section name that could not be one is dropped rather than searched for.
 */
export interface SettingsView {
  leaf: string | null;
  section: string | null;
  q: string;
}

export function settingsViewFromUrl(search: string): SettingsView {
  const params = new URLSearchParams(search);
  const section = params.get("section")?.trim() ?? "";
  return {
    leaf: settingsLeafFromUrl(search),
    section: section.length <= 64 && /^[a-z0-9_]+$/i.test(section) ? section : null,
    q: (params.get("q") ?? "").slice(0, 128),
  };
}

/**
 * What a `?leaf=` address points at among the settings on screen: the setting
 * itself, or — for a group such as `llm.providers.anthropic` — its first
 * setting. `null` only when nothing lives under that path.
 */
export function settingLeafTarget(
  paths: readonly string[],
  leaf: string,
): { index: number; kind: "leaf" | "group" } | null {
  const exact = paths.indexOf(leaf);
  if (exact >= 0) return { index: exact, kind: "leaf" };
  const first = paths.findIndex((path) => path.startsWith(`${leaf}.`));
  return first >= 0 ? { index: first, kind: "group" } : null;
}

/**
 * The section a setting lives in: its first path segment. `tokens.monthly_budget`
 * opens on `tokens`.
 */
export function settingSectionOf(path: string): string {
  return path.split(".")[0] || "other";
}

/**
 * A setting's name in the reader's language, keyed by its whole dotted path.
 *
 * The engine describes each leaf but does not label it. The page first guessed
 * a label from keywords ("Schwellenwert", "Konfigurationswert"), then used the
 * last path segment in English — nine settings read "Api key" on a German
 * page. Every leaf the engine has is named in the catalogue
 * (`settings.leaf.<path>`, held against the engine's own walk by
 * settings-leaf-coverage.test.ts), with its parent where a section holds several
 * of a kind ("Anthropic · API-Schlüssel"). A path this build does not know is
 * the path itself, marked as a machine value.
 */
export function settingLabel(path: string, t: Translate): CatalogLabel {
  const key = `settings.leaf.${path}`;
  return Object.hasOwn(CATALOGS.en, key)
    ? { text: t(key as TranslationKey), machine: false }
    : { text: path, machine: true };
}

/** Every top-level section the engine's configuration has, by its name. */
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

/** A section's name; one this build does not know is its key, marked as such. */
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

/**
 * The sections, grouped by what an operator comes to change.
 *
 * Twenty sections side by side were a tab strip twice as wide as the page,
 * scrolled sideways to find "Token-Budget". Grouped and stacked, every section
 * is on screen at once. Every section the engine has is placed here —
 * settings-groups.test.ts walks the engine's configuration and fails on one
 * that is not.
 */
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

/**
 * The section list for the settings the engine reported: each group with the
 * sections that have settings, in the declared order. A section a newer engine
 * adds and this build has not placed yet stands in a trailing group rather
 * than vanishing.
 */
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

/** Whether a setting matches the search: its path, its name or the engine's description. */
export function settingMatches(item: SettingItem, needle: string, t: Translate): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) return true;
  return (
    item.path.toLowerCase().includes(query) ||
    Boolean(item.meta.description?.toLowerCase().includes(query)) ||
    settingLabel(item.path, t).text.toLowerCase().includes(query)
  );
}

/**
 * What the page asks of the reader before any section: settings saved but
 * waiting for a restart, and a last change that failed to activate. Nothing
 * when neither holds — the revision numbers and a count of resolved settings
 * used to stand here as four tiles on every visit, with nothing to do.
 */
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
