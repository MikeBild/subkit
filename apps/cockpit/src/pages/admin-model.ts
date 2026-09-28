import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

// The installation pages name roles, permissions and where a setting came
// from. Each of these used to answer "Unbekannt" for a value it had no word
// for — a word §2 bans, about a value the engine had recorded exactly. What
// this build knows is named; the rest is the engine's own value, marked as a
// machine value so it renders as one (`LabelText`).

const ROLE_KEYS: Readonly<Record<string, TranslationKey>> = {
  config: "settings.meta.configuration",
  admin: "role.admin",
  member: "role.member",
  enduser: "role.enduser",
  metrics_scraper: "role.metricsScraper",
  portal_token_user: "role.portalTokenUser",
};

export function roleLabel(role: string, t: Translate): CatalogLabel {
  return catalogLabel(role, ROLE_KEYS[role], t);
}

const PERMISSION_RESOURCE_KEYS: Readonly<Record<string, TranslationKey>> = {
  api_key: "permission.resource.apiKeys",
  audit: "nav.audit",
  chat_identity: "permission.resource.chatIdentity",
  chat_workspace: "permission.resource.chatWorkspace",
  connection: "apiAccess.section.grants",
  connector: "resource.connectors.title",
  conversation: "nav.chat",
  credential: "permission.resource.credentials",
  discovery: "permission.resource.discovery",
  execution: "resource.runs.title",
  file: "resource.files.title",
  identity: "resource.people.title",
  mcp_external_tool: "permission.resource.mcpExternalTools",
  memory: "permission.resource.memory",
  schedule: "permission.resource.schedules",
  subscription: "permission.resource.subscriptions",
  inbound_hook: "permission.resource.inboundHooks",
  knowledge: "resource.knowledge.title",
  mcp: "permission.resource.mcp",
  mcp_oauth_client: "permission.resource.mcpClients",
  metrics: "permission.resource.metrics",
  notification: "resource.inbox.title",
  portal_token: "permission.resource.portalTokens",
  rbac: "resource.access.title",
  self_healing: "resource.operations.title",
  settings: "resource.settings.title",
  skill: "resource.skills.title",
  stats: "resource.usage.title",
  workflow: "resource.workflows.title",
};

const PERMISSION_ACTION_KEYS: Readonly<Record<string, TranslationKey>> = {
  abort: "permission.action.abort",
  activate: "permission.action.activate",
  admin: "permission.action.admin",
  approve: "permission.action.approve",
  archive: "permission.action.archive",
  authoring: "permission.action.authoring",
  cancel: "permission.action.cancel",
  commit: "permission.action.commit",
  delete: "permission.action.delete",
  export: "permission.action.export",
  import: "permission.action.import",
  invoke: "permission.action.invoke",
  list: "permission.action.list",
  oauth: "permission.action.oauth",
  pause: "permission.action.pause",
  promote: "permission.action.promote",
  propose: "permission.action.propose",
  read: "permission.action.read",
  replay: "permission.action.replay",
  restore: "permission.action.restore",
  resume: "permission.action.resume",
  revoke: "permission.action.revoke",
  rotate: "permission.action.rotate",
  run: "permission.action.run",
  signal: "permission.action.signal",
  test: "permission.action.test",
  write: "permission.action.write",
};

/**
 * `workflow:run` as "Workflows · Ausführen"; a part this build cannot name
 * keeps the whole token.
 *
 * A third segment narrows the permission's reach — `stats:read:all` reads
 * EVERYONE's usage where `stats:read` reads one's own. Dropping it, as the
 * two-part split did, gave the two rights one name.
 */
export function permissionLabel(permission: string, t: Translate): CatalogLabel {
  const [resource, action, reach, ...rest] = permission.split(":");
  const resourceKey = resource ? PERMISSION_RESOURCE_KEYS[resource] : undefined;
  const actionKey = action ? PERMISSION_ACTION_KEYS[action] : undefined;
  if (!resourceKey || !actionKey || rest.length > 0) return { text: permission, machine: true };
  const values = { resource: t(resourceKey), action: t(actionKey) };
  if (reach === undefined) return { text: t("permission.label", values), machine: false };
  if (reach === "all") return { text: t("permission.labelAll", values), machine: false };
  return { text: permission, machine: true };
}

/** What kind of thing a permission or grant is about — `connector` as "Connectoren". */
export function resourceTypeLabel(resourceType: string, t: Translate): CatalogLabel {
  return catalogLabel(resourceType, PERMISSION_RESOURCE_KEYS[resourceType], t);
}

// ---------------------------------------------------------------------------
// Roles as a person holds them.

export interface RoleLike {
  id: string;
  name: string;
  is_builtin: boolean;
}

/** The three roles the identity API assigns itself; every other role goes through RBAC. */
export const PERSON_ROLES = ["admin", "member", "enduser"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export function isPersonRole(name: string): name is PersonRole {
  return (PERSON_ROLES as readonly string[]).includes(name);
}

/**
 * A role by its name — a built-in one in the reader's language, a custom one
 * by the name its author gave it.
 *
 * A custom role's name IS its name. Showing it as a machine value (or, before
 * that, as "Unbekannt") treated the one role an administrator named on purpose
 * as the one the cockpit could not read.
 */
export function roleName(
  name: string,
  roles: readonly RoleLike[] | undefined,
  t: Translate,
): CatalogLabel {
  const known = ROLE_KEYS[name];
  if (known) return { text: t(known), machine: false };
  const role = roles?.find((candidate) => candidate.name === name);
  if (role && !role.is_builtin) return { text: role.name, machine: false };
  return { text: name, machine: true };
}

/**
 * The roles a PERSON can be given, in the order a reader looks for them.
 *
 * The three person roles, then every role this workspace defined. The other
 * built-ins are left out on purpose: `metrics_scraper` and `portal_token_user`
 * back machine principals — a Prometheus scraper, a portal token — and a
 * person holding one is a misconfiguration, not a choice to offer.
 */
export function assignableRoles<T extends RoleLike>(roles: readonly T[]): T[] {
  const people = PERSON_ROLES.flatMap((name) =>
    roles.filter((role) => role.is_builtin && role.name === name),
  );
  const custom = roles
    .filter((role) => !role.is_builtin)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...people, ...custom];
}

/**
 * What a role change does beyond its permission list.
 *
 * People and role management are checked by the role NAME `admin`, not by a
 * permission: a custom role holding every permission still cannot manage
 * people. So leaving `admin` always takes that away, whatever the diff says —
 * and "the rights stay the same" would be false. Changing one's own role is
 * said as such, because the reader is the one who loses it.
 */
export type RoleChangeNote = "leavesAdmin" | "self" | "selfLeavesAdmin";

export function roleChangeNotes(change: {
  from: string;
  to: string;
  isSelf: boolean;
}): RoleChangeNote[] {
  const leavesAdmin = change.from === "admin" && change.to !== "admin";
  if (change.isSelf && leavesAdmin) return ["selfLeavesAdmin"];
  if (leavesAdmin) return ["leavesAdmin"];
  return change.isSelf ? ["self"] : [];
}

const REFUSAL_KEYS: Readonly<Record<string, TranslationKey>> = {
  last_admin: "people.refusal.lastAdmin",
  forbidden: "people.refusal.forbidden",
  not_found: "people.refusal.notFound",
};

/**
 * Why the engine refused a change to a person, in words: the known codes
 * translated, anything else the engine's own sentence, never a bare "failed".
 */
export function personRefusal(
  error: { code?: string | null; message?: string } | null | undefined,
  t: Translate,
): string {
  const key = error?.code ? REFUSAL_KEYS[error.code] : undefined;
  if (key) return t(key);
  return error?.message
    ? t("people.refusal.engine", { reason: error.message })
    : t("people.roleUpdateFailed");
}

/** What a person gains and loses when one role replaces another. */
export function roleChange(
  from: readonly string[],
  to: readonly string[],
): { gained: string[]; lost: string[] } {
  const before = new Set(from);
  const after = new Set(to);
  return {
    gained: [...after].filter((permission) => !before.has(permission)).sort(),
    lost: [...before].filter((permission) => !after.has(permission)).sort(),
  };
}

// ---------------------------------------------------------------------------
// Grants on a single record.

/**
 * The record types this page can grant on, each with a list to pick from.
 *
 * The engine checks a grant wherever a route names the record it guards —
 * workflows, connectors, skills, runs and a few more. A picker needs a list of
 * names; these two have one here, and the page says in a sentence that the
 * rest are granted through the API rather than pretending a workflow picker
 * covers them.
 */
export const GRANT_RESOURCE_TYPES = ["workflow", "connector"] as const;
export type GrantResourceType = (typeof GRANT_RESOURCE_TYPES)[number];

export function isGrantResourceType(value: string): value is GrantResourceType {
  return (GRANT_RESOURCE_TYPES as readonly string[]).includes(value);
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
 * at, the tab and the search. A reload or a shared link lands on the same view;
 * a tab name that could not be one is dropped rather than searched for.
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
 * The tab a setting lives on: its first path segment. `tokens.monthly_budget`
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
 * settings-leaf-coverage.test.ts), with its parent where a tab holds several of
 * a kind ("Anthropic · API-Schlüssel"). A path this build does not know is the
 * path itself, marked as a machine value.
 */
export function settingLabel(path: string, t: Translate): CatalogLabel {
  const key = `settings.leaf.${path}`;
  return Object.hasOwn(CATALOGS.en, key)
    ? { text: t(key as TranslationKey), machine: false }
    : { text: path, machine: true };
}

const ACTIVATION_KEYS: Readonly<Record<string, TranslationKey>> = {
  saved: "settings.activation.saved",
  preparing: "settings.activation.preparing",
  active: "settings.activation.active",
  failed: "settings.activation.failed",
  restart_required: "settings.activation.restartRequired",
};

/** Where the saved configuration stands, in words — never `restart required` as the enum spells it. */
export function activationStatusLabel(
  status: string | null | undefined,
  t: Translate,
): CatalogLabel {
  // Not reported is not active: a missing state must not read as the good one.
  if (!status) return { text: t("settings.activation.unreported"), machine: false };
  return catalogLabel(status, ACTIVATION_KEYS[status], t);
}

/** Where a setting's value came from, or which scope it applies to. */
export function settingMetaLabel(value: string, t: Translate): CatalogLabel {
  return catalogLabel(value, SETTING_META_KEYS[value.toLowerCase()], t);
}
