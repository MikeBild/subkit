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
    /** The schema's default; absent where the engine has none to report. */
    default?: unknown;
    /** An enum's allowed values, in the engine's order. */
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
export type SettingsFilter = "all" | "changed";

export interface SettingsView {
  leaf: string | null;
  section: string | null;
  q: string;
  /** `?filter=changed` shows only settings that differ from their default. */
  filter: SettingsFilter;
}

export function settingsViewFromUrl(search: string): SettingsView {
  const params = new URLSearchParams(search);
  const section = params.get("section")?.trim() ?? "";
  return {
    leaf: settingsLeafFromUrl(search),
    section: section.length <= 64 && /^[a-z0-9_]+$/i.test(section) ? section : null,
    q: (params.get("q") ?? "").slice(0, 128),
    filter: params.get("filter") === "changed" ? "changed" : "all",
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
 * settings-model.test.ts walks the engine's configuration and fails on one
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

/** A setting nobody set: the engine sends null, which is not a value to show. */
export function isUnset(item: Pick<SettingItem, "value">): boolean {
  return item.value === null || item.value === undefined;
}

/**
 * What a text field shows: the unsaved draft, else the stored value. A secret
 * never shows, and an unset setting reads as an empty field with a
 * "nicht gesetzt" placeholder — never as the word "null".
 */
export function settingFieldValue(
  item: Pick<SettingItem, "value" | "meta">,
  draft: string | undefined,
): string {
  if (draft !== undefined) return draft;
  if (item.meta.sensitive || isUnset(item)) return "";
  return typeof item.value === "string" ? item.value : JSON.stringify(item.value);
}

/** Two setting values are the same when their JSON is, whatever the key order. */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    return value === undefined ? null : value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Whether the engine reported a default for this setting at all. */
export function settingHasDefault(item: Pick<SettingItem, "meta">): boolean {
  return Object.hasOwn(item.meta, "default");
}

/** A secret the engine holds a value for: it reports `***`, never the value. */
export function settingSecretStored(item: Pick<SettingItem, "value" | "meta">): boolean {
  return item.meta.sensitive && !isUnset(item) && item.value !== "";
}

/**
 * Whether the stored value differs from the schema's default — what the
 * "Geändert" filter shows. A stored secret counts: its default is none. A
 * setting without a reported default is never "changed"; there is nothing to
 * compare it with.
 */
export function settingIsChanged(item: SettingItem): boolean {
  if (item.meta.sensitive) return settingSecretStored(item);
  if (!settingHasDefault(item)) return false;
  return !sameSettingValue(item.value, item.meta.default);
}

/** The text a field holds for a value: strings as they are, everything else as JSON. */
export function settingDraftText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isNumberSetting(item: Pick<SettingItem, "value" | "meta">): boolean {
  return item.meta.kind === "number" || typeof item.value === "number";
}

/**
 * The value a draft stands for, by the setting's kind. `undefined` when the
 * draft is no value of that kind — an empty or non-numeric number, broken
 * JSON — so its row flags it and it is never sent as a silent 0.
 */
export function parseSettingDraft(item: Pick<SettingItem, "value" | "meta">, raw: string): unknown {
  const kind = item.meta.kind;
  if (kind === "boolean" || typeof item.value === "boolean") return raw === "true";
  if (isNumberSetting(item)) {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : undefined;
  }
  // An enum set to "nicht gesetzt" drafts the empty string: the engine's null.
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

/** Why a draft cannot be saved, or null when it can. */
export function settingDraftError(
  item: Pick<SettingItem, "value" | "meta">,
  raw: string | undefined,
): "settings.invalidNumber" | "settings.invalidJson" | null {
  if (raw === undefined || item.meta.sensitive) return null;
  if (parseSettingDraft(item, raw) !== undefined) return null;
  return isNumberSetting(item) ? "settings.invalidNumber" : "settings.invalidJson";
}

/**
 * Whether the value on screen — the draft, else the stored value — differs
 * from the default; the row then says "Geändert · Standard: X · Zurücksetzen".
 * Never for a secret (its row says whether one is stored) and never for a
 * setting without a reported default.
 */
export function settingDiffersFromDefault(item: SettingItem, draft: string | undefined): boolean {
  if (item.meta.sensitive || !settingHasDefault(item)) return false;
  const value = draft === undefined ? item.value : parseSettingDraft(item, draft);
  return value === undefined || !sameSettingValue(value, item.meta.default);
}

/**
 * The draft "Zurücksetzen" writes: the default, as the field would hold it.
 * Null where nothing is safe to draft — a secret, whose empty default would
 * erase a stored credential, or a setting without a reported default.
 */
export function settingResetDraft(item: SettingItem): string | null {
  if (item.meta.sensitive || !settingHasDefault(item)) return null;
  return settingDraftText(item.meta.default);
}

/** A value as a row names it: "An"/"Aus", "Nicht gesetzt", "leer", or itself, shortened. */
export function settingValueText(value: unknown, t: Translate): string {
  if (value === null || value === undefined) return t("settings.unset");
  if (typeof value === "boolean") return t(value ? "settings.value.on" : "settings.value.off");
  if (value === "" || (Array.isArray(value) && value.length === 0))
    return t("settings.value.empty");
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * The unit a number setting counts in, read from its name: `…_ms` is
 * milliseconds, `…_bytes` bytes. Null where the name does not say — a count,
 * a fraction — rather than a guess.
 */
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

/**
 * What to know before changing a setting, in the reader's language, or
 * nothing. Keyed by the whole path (`settings.help.<path>`); a row without an
 * entry shows no help. settings-leaf-coverage.test.ts names which settings
 * must have one.
 */
export function settingHelpKey(path: string): TranslationKey | null {
  const key = `settings.help.${path}`;
  return Object.hasOwn(CATALOGS.en, key) ? (key as TranslationKey) : null;
}

/**
 * The one request a save sends: every draft on the page, against the revision
 * the page was read at. A secret travels as the `secret://` reference of the
 * version created for it just before; its plaintext never enters the patch.
 */
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

/**
 * Where the revision a save produced is activated. The engine saves a PATCH
 * without activating it; a setting that needs a restart stays saved and the
 * activation reports `restart_required`, which the status line then names.
 */
export function settingsActivationPath(saved: { saved_revision: number }): string {
  return `/v1/settings/revisions/${saved.saved_revision}/activate`;
}

/** The secret name a setting's value is stored under — the engine's own settings naming. */
export function settingSecretName(path: string): string {
  return `settings.${path}`;
}

/**
 * How a failed save reads. A 409 is somebody else's newer revision: the page
 * says so and keeps the drafts. Anything else is a plain failure.
 */
export function settingsSaveFailure(error: unknown): "conflict" | "failed" {
  return (error as { status?: unknown } | null)?.status === 409 ? "conflict" : "failed";
}
