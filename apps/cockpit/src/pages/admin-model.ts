import { PEOPLE_SECTIONS, type PeopleSection } from "@/app/links";
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
  connection: "apiAccess.section.grants",
  connector: "resource.connectors.title",
  conversation: "nav.chat",
  credential: "permission.resource.credentials",
  discovery: "permission.resource.discovery",
  execution: "resource.runs.title",
  file: "resource.files.title",
  identity: "people.section.people",
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
  rbac: "permission.resource.rbac",
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

/**
 * The sections of Personen & Rechte this reader may read, in page order. The
 * people list is behind `identity:read`; roles, groups and grants behind
 * `rbac:read`. A section the reader cannot read is absent, not a failed load.
 */
export function readablePeopleSections(can: { identity: boolean; rbac: boolean }): PeopleSection[] {
  return PEOPLE_SECTIONS.filter((section) => (section === "people" ? can.identity : can.rbac));
}

/**
 * The section the page opens at: the one the address names when the reader
 * may read it, else the first one they may. Null only for a reader who may
 * read none of them.
 */
export function openPeopleSection(
  requested: PeopleSection | null,
  readable: readonly PeopleSection[],
): PeopleSection | null {
  if (requested && readable.includes(requested)) return requested;
  return readable[0] ?? null;
}
