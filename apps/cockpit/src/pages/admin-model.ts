import { PEOPLE_SECTIONS, type PeopleSection } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

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
  connection: "permission.resource.connections",
  connector: "resource.connectors.title",
  conversation: "nav.chat",
  credential: "permission.resource.credentials",
  discovery: "permission.resource.discovery",
  execution: "resource.runs.title",
  file: "resource.files.title",
  identity: "people.section.people",
  intake: "permission.resource.intake",
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
  package: "permission.resource.packages",
  portal_token: "permission.resource.portalTokens",
  rbac: "permission.resource.rbac",
  self_healing: "resource.operations.title",
  settings: "resource.settings.title",
  skill: "resource.skills.title",
  stats: "resource.usage.title",
  system: "permission.resource.engine",
  task: "permission.resource.tasks",
  task_run: "permission.resource.taskRuns",
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
  confirm: "permission.action.confirm",
  delete: "permission.action.delete",
  disable: "permission.action.disable",
  export: "permission.action.export",
  grant: "permission.action.grant",
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
  restart: "permission.action.restart",
  resume: "permission.action.resume",
  revoke: "permission.action.revoke",
  rotate: "permission.action.rotate",
  run: "permission.action.run",
  signal: "permission.action.signal",
  test: "permission.action.test",
  write: "permission.action.write",
};

export function permissionLabel(permission: string, t: Translate): CatalogLabel {
  const [resource, action, reach, ...rest] = permission.split(":");
  const resourceKey = resource ? PERMISSION_RESOURCE_KEYS[resource] : undefined;
  const actionKey = action ? PERMISSION_ACTION_KEYS[action] : undefined;
  if (!resourceKey || !actionKey || rest.length > 0) return { text: permission, machine: true };
  const values = { resource: t(resourceKey), action: t(actionKey) };
  if (reach === undefined) return { text: t("permission.label", values), machine: false };
  if (reach === "all") return { text: t("permission.labelAll", values), machine: false };
  if (reach === "global") return { text: t("permission.labelGlobal", values), machine: false };
  return { text: permission, machine: true };
}

interface PermissionGroup {
  key: string;
  area: CatalogLabel;
  items: CatalogLabel[];
}

function permissionActionLabel(permission: string, t: Translate): CatalogLabel {
  const [, action, reach, ...rest] = permission.split(":");
  const actionKey = action ? PERMISSION_ACTION_KEYS[action] : undefined;
  if (
    !actionKey ||
    rest.length > 0 ||
    (reach !== undefined && reach !== "all" && reach !== "global")
  )
    return { text: permission, machine: true };
  const text = t(actionKey);
  const reachText =
    reach === "all"
      ? t("permission.actionAll", { action: text })
      : reach === "global"
        ? t("permission.actionGlobal", { action: text })
        : text;
  return { text: reachText, machine: false };
}

export function permissionGroups(permissions: readonly string[], t: Translate): PermissionGroup[] {
  const byArea = new Map<string, string[]>();
  for (const permission of permissions) {
    const [resource = permission] = permission.split(":");
    byArea.set(resource, [...(byArea.get(resource) ?? []), permission]);
  }
  return [...byArea.entries()]
    .map(([resource, held]) => {
      const areaKey = PERMISSION_RESOURCE_KEYS[resource];
      const known = Boolean(areaKey);
      return {
        key: resource,
        area: catalogLabel(resource, areaKey, t),
        items: [...held]
          .sort()
          .map((permission) =>
            known ? permissionActionLabel(permission, t) : { text: permission, machine: true },
          ),
      };
    })
    .sort((a, b) => a.area.text.localeCompare(b.area.text));
}

export function resourceTypeLabel(resourceType: string, t: Translate): CatalogLabel {
  return catalogLabel(resourceType, PERMISSION_RESOURCE_KEYS[resourceType], t);
}

interface RoleLike {
  id: string;
  name: string;
  is_builtin: boolean;
}

export const PERSON_ROLES = ["admin", "member", "enduser"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export function isPersonRole(name: string): name is PersonRole {
  return (PERSON_ROLES as readonly string[]).includes(name);
}

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

export function assignableRoles<T extends RoleLike>(roles: readonly T[]): T[] {
  const people = PERSON_ROLES.flatMap((name) =>
    roles.filter((role) => role.is_builtin && role.name === name),
  );
  const custom = roles
    .filter((role) => !role.is_builtin)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...people, ...custom];
}

type RoleChangeNote = "leavesAdmin" | "self" | "selfLeavesAdmin";

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

export const GRANT_RESOURCE_TYPES = ["workflow", "connector"] as const;
export type GrantResourceType = (typeof GRANT_RESOURCE_TYPES)[number];

export function isGrantResourceType(value: string): value is GrantResourceType {
  return (GRANT_RESOURCE_TYPES as readonly string[]).includes(value);
}

export function readablePeopleSections(can: {
  identity: boolean;
  rbac: boolean;
  settings: boolean;
}): PeopleSection[] {
  return PEOPLE_SECTIONS.filter((section) => {
    if (section === "people") return can.identity;
    if (section === "apps") return can.settings;
    return can.rbac;
  });
}

export function openPeopleSection(
  requested: PeopleSection | null,
  readable: readonly PeopleSection[],
): PeopleSection | null {
  if (requested && readable.includes(requested)) return requested;
  return readable[0] ?? null;
}

export function membershipNames(
  groups: readonly { name: string }[] | null | undefined,
  t: Translate,
): string {
  if (groups == null) return t("access.membershipUnknown");
  return groups.length ? groups.map((group) => group.name).join(", ") : t("access.noMemberships");
}

export function grantStatus(
  expiresAt: string | null,
  now: number,
): "active" | "expired" | "unknown" {
  if (expiresAt === null) return "active";
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) ? (expires <= now ? "expired" : "active") : "unknown";
}
