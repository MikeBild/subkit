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
  api_key: "nav.apiAccess",
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
  inbound_hook: "permission.resource.inboundHooks",
  knowledge: "resource.knowledge.title",
  mcp: "permission.resource.mcp",
  mcp_external_tool: "permission.resource.mcpExternalTools",
  mcp_oauth_client: "permission.resource.mcpClients",
  memory: "permission.resource.memory",
  metrics: "permission.resource.metrics",
  notification: "resource.inbox.title",
  portal_token: "permission.resource.portalTokens",
  rbac: "resource.access.title",
  schedule: "permission.resource.schedules",
  self_healing: "resource.operations.title",
  settings: "resource.settings.title",
  skill: "resource.skills.title",
  stats: "resource.usage.title",
  subscription: "permission.resource.subscriptions",
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

/** `workflow:run` as "Workflows ausführen"; a half this build cannot name keeps the whole token. */
export function permissionLabel(permission: string, t: Translate): CatalogLabel {
  const [resource, action] = permission.split(":");
  const resourceKey = resource ? PERMISSION_RESOURCE_KEYS[resource] : undefined;
  const actionKey = action ? PERMISSION_ACTION_KEYS[action] : undefined;
  if (!resourceKey || !actionKey) return { text: permission, machine: true };
  return {
    text: t("permission.label", { resource: t(resourceKey), action: t(actionKey) }),
    machine: false,
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

/** Where a setting's value came from, or which scope it applies to. */
export function settingMetaLabel(value: string, t: Translate): CatalogLabel {
  return catalogLabel(value, SETTING_META_KEYS[value.toLowerCase()], t);
}
