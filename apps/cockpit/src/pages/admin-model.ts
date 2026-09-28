import type { TranslationKey } from "@/lib/i18n";
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
  connector: "resource.connectors.title",
  conversation: "nav.chat",
  credential: "permission.resource.credentials",
  discovery: "permission.resource.discovery",
  execution: "resource.runs.title",
  file: "resource.files.title",
  identity: "resource.people.title",
  connection: "permission.resource.connections",
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
  export: "permission.action.export",
  import: "permission.action.import",
  invoke: "permission.action.invoke",
  pause: "permission.action.pause",
  propose: "permission.action.propose",
  replay: "permission.action.replay",
  restore: "permission.action.restore",
  resume: "permission.action.resume",
  delete: "permission.action.delete",
  list: "permission.action.list",
  oauth: "permission.action.oauth",
  promote: "permission.action.promote",
  read: "permission.action.read",
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
 * The tab a setting lives on: its first path segment. `tokens.monthly_budget`
 * opens on `tokens`.
 */
export function settingSectionOf(path: string): string {
  return path.split(".")[0] || "other";
}

/**
 * A setting's name, read off its own path.
 *
 * The engine names and describes each leaf; it does not label it. The page
 * used to guess a label from keywords in the path — every threshold became
 * "Schwellenwert", everything else "Konfigurationswert" — so a section read as
 * a column of identical words. The leaf's own name, spaced and capitalised, is
 * the one label that tells two settings apart; the engine's description stands
 * under it.
 */
export function settingLeafLabel(path: string): string {
  const leaf = path.split(".").at(-1) ?? path;
  const words = leaf.replace(/_/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : path;
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
  if (!status) return { text: t("settings.activation.active"), machine: false };
  return catalogLabel(status, ACTIVATION_KEYS[status], t);
}

/** Where a setting's value came from, or which scope it applies to. */
export function settingMetaLabel(value: string, t: Translate): CatalogLabel {
  return catalogLabel(value, SETTING_META_KEYS[value.toLowerCase()], t);
}
