import type { components } from "@/api/schema";
import {
  absolute,
  connectorHref,
  conversationHref,
  identifierParam,
  instantParam,
  recordHref,
  runHref,
  workflowHref,
} from "@/app/links";
import type { CatalogResource } from "@/app/route-table";
import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";
import type { NameIndex } from "@/lib/name-index";

type AuditEntry = components["schemas"]["AuditEntry"];
type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;
type FormatDateTime = (value: string | Date) => string;

const RESOURCE_ROUTES: Record<string, CatalogResource | "chat" | "runs"> = {
  workflow: "workflows",
  connector: "connectors",
  knowledge_source: "knowledge",
  skill: "skills",
  file: "files",
  conversation: "chat",
  execution: "runs",
};

export const LINKED_RESOURCE_TYPES: readonly string[] = Object.keys(RESOURCE_ROUTES);

export function auditResourceHref(resourceType: string, resourceId: string | null): string | null {
  if (!resourceId) return null;
  const route = RESOURCE_ROUTES[resourceType];
  if (!route) return null;
  return absolute(
    route === "chat"
      ? conversationHref(resourceId)
      : route === "runs"
        ? runHref(resourceId)
        : recordHref(route, resourceId),
  );
}

const ACTOR_KEYS: Record<string, TranslationKey> = {
  user: "audit.actor.user",
  system_account: "audit.actor.systemAccount",
  system: "audit.actor.system",
};

export function actorTypeLabel(actorType: string, t: Translate): CatalogLabel {
  return catalogLabel(actorType, ACTOR_KEYS[actorType], t);
}

export function canReadDirectory(session: {
  permissions: readonly string[];
  principal: { role_name?: string | null };
}): boolean {
  return session.permissions.includes("identity:read") && session.principal.role_name === "admin";
}

export function auditActorName(
  entry: Pick<AuditEntry, "actor_type" | "actor_id">,
  directory: ReadonlyMap<string, string>,
  t: Translate,
): CatalogLabel | null {
  const kind = entry.actor_type?.trim() ?? "";
  const named = entry.actor_id ? directory.get(entry.actor_id) : undefined;
  if (named) return { text: named, machine: false };
  if (!kind) return null;
  return actorTypeLabel(kind, t);
}

const RESULT_KEYS: Record<string, TranslationKey> = {
  success: "audit.result.success",
  denied: "audit.result.denied",
  error: "audit.result.error",
};

export function auditResultLabel(result: string, t: Translate): CatalogLabel {
  return catalogLabel(result, RESULT_KEYS[result], t);
}

const REASON_KEYS: Record<string, TranslationKey> = {
  expired_sliding: "audit.reason.expiredSliding",
  expired_absolute: "audit.reason.expiredAbsolute",
  idle_timeout: "audit.reason.idleTimeout",
  logout: "audit.reason.logout",
  revoked: "audit.reason.revoked",
  user_deactivated: "audit.reason.userDeactivated",
  bad_signature: "audit.reason.badSignature",
  credential_rejected: "audit.reason.credentialRejected",
  circuit_open: "audit.reason.circuitOpen",
  operator_rejected_confirmation: "audit.reason.operatorRejected",
  execution_authority_required: "audit.reason.authorityRequired",
  execution_authority_unavailable: "audit.reason.authorityUnavailable",
  refresh_replayed: "audit.reason.refreshReplayed",
  manual_re_issue: "audit.reason.manualReissue",
  client_retired: "audit.reason.clientRetired",
};

export function auditReasonLabel(
  reason: string | null | undefined,
  t: Translate,
): CatalogLabel | null {
  const text = reason?.trim() ?? "";
  if (!text) return null;
  if (!/^[a-z][a-z0-9_.:-]*$/.test(text)) return { text, machine: false };
  return catalogLabel(text, REASON_KEYS[text], t);
}

const RESOURCE_KEYS: Record<string, TranslationKey> = {
  workflow: "nav.workflows",
  patch_candidate: "decisions.kind.patch",
  skill_candidate: "decisions.kind.skill",
  connector: "resource.connectors.title",
  knowledge_source: "nav.knowledge",
  skill: "nav.skills",
  file: "nav.files",
  catalog_category: "catalogMeta.category",
  conversation: "nav.chat",
  session: "audit.resource.session",
  user_identity: "audit.resource.userIdentity",
  credential: "permission.resource.credentials",
  setting: "nav.settings",
  webhook_inbound: "audit.resource.inboundWebhook",
  mcp_oauth_client: "audit.resource.oauthClient",
  mcp_oauth_code: "audit.resource.oauthCode",
  mcp_oauth_token: "audit.resource.oauthToken",
  notification_delivery: "nav.notifications",
  execution: "nav.runs",
  api_key: "nav.apiAccess",
  role: "access.roles",
  user: "people.section.people",
  settings: "nav.settings",
  connection: "permission.resource.connections",
  schedule: "permission.resource.schedules",
  subscription: "permission.resource.subscriptions",
  inbound_hook: "permission.resource.inboundHooks",
  portal_token: "permission.resource.portalTokens",
  resource_grant: "access.grants",
  group: "access.groups",
  system_account: "audit.actor.systemAccount",
  user_invite: "people.invite",
  workflow_run: "nav.runs",
  runtime_secret: "audit.resource.runtimeSecret",
  chat_workspace: "audit.resource.chatWorkspace",
  chat_identity: "audit.resource.chatIdentity",
  chat_message: "audit.resource.chatMessage",
  chat_events_seen: "audit.resource.chatEventsSeen",
  conversation_elicitation: "audit.resource.conversationQuestion",
  runtime_config_revision: "audit.resource.settingsRevision",
  workflow_schedule: "audit.resource.workflowSchedule",
  self_healing_scan: "audit.resource.selfHealingScan",
  engine: "audit.resource.engine",
  discovery_run: "audit.resource.discoveryRun",
  discovery_artifact: "audit.resource.discoveryArtifact",
  tenant: "audit.resource.tenant",
  request_hook: "audit.resource.requestHook",
  notification_rule: "audit.resource.notificationRule",
  notification_channel: "audit.resource.notificationChannel",
  llm: "audit.resource.llm",
  extract: "audit.resource.extract",
  workflow_execution_authority: "audit.resource.executionAuthority",
  tool_approval: "audit.resource.toolApproval",
  operator_health_digest: "audit.resource.healthDigest",
  mcp_external_tool: "audit.resource.externalMcpTool",
  log_ring: "audit.resource.logRing",
  connector_template: "audit.resource.connectorTemplate",
  connector_template_credential: "audit.resource.connectorTemplateCredential",
  cli_notification_inbox: "audit.resource.cliInbox",
  bootstrap: "audit.resource.bootstrap",
  stateless_bridge: "audit.resource.objectStorageMigration",
  scope: "audit.resource.scope",
  migrations_journal: "audit.resource.migrationsJournal",
  event: "audit.resource.event",
  mcp_tool_call: "audit.resource.mcpToolCall",
  conversation_tool_call: "audit.resource.chatToolCall",
  execution_offload: "audit.resource.executionOffload",
  policy: "audit.resource.policy",
  tool: "audit.resource.tool",
  system: "audit.resource.system",
};

export function auditResourceLabel(resourceType: string, t: Translate): CatalogLabel {
  return catalogLabel(resourceType, RESOURCE_KEYS[resourceType], t);
}

const ACTION_KEYS: Record<string, TranslationKey> = {
  "approval.requested": "audit.action.approvalRequested",
  "approval.granted": "audit.action.approvalGranted",
  "approval.approved": "audit.action.approvalApproved",
  "approval.rejected": "audit.action.approvalRejected",
  "approval.declined": "audit.action.approvalDeclined",
  "approval.grant_abandoned": "audit.action.approvalAbandoned",
  "approval.dispatch_denied": "audit.action.approvalDispatchDenied",
  "workflow.authority_granted": "audit.action.authorityGranted",
  "workflow.authority_revoked": "audit.action.authorityRevoked",
  "workflow.authority_inherited": "audit.action.authorityInherited",
  "policy.denied": "audit.action.policyDenied",
  "execution.boundary_refused": "audit.action.boundaryRefused",
  "rbac.role_created": "audit.action.roleCreated",
  "rbac.role_deleted": "audit.action.roleDeleted",
  "rbac.permission_granted": "audit.action.permissionGranted",
  "rbac.permission_revoked": "audit.action.permissionRevoked",
  "rbac.user_role_assigned": "audit.action.userRoleAssigned",
  "rbac.user_role_revoked": "audit.action.userRoleRevoked",
  "user.created": "audit.action.userCreated",
  "user.deleted": "audit.action.userDeleted",
  "user.role_changed": "audit.action.userRoleChanged",
  "user.invited": "audit.action.userInvited",
  "api_key.issued": "audit.action.apiKeyIssued",
  "api_key.revoked": "audit.action.apiKeyRevoked",
  "api_key.rotated": "audit.action.apiKeyRotated",
  "session.revoked": "audit.action.sessionRevoked",
  "auth.login_failed": "audit.action.loginFailed",
  "schedule.created": "audit.action.scheduleCreated",
  "schedule.updated": "audit.action.scheduleUpdated",
  "schedule.deleted": "audit.action.scheduleDeleted",
  "workflow.deleted": "audit.action.workflowDeleted",
  "workflow.version_restored": "audit.action.workflowRestored",
  "knowledge_source.restored": "audit.action.knowledgeRestored",
  "connector.created": "audit.action.connectorCreated",
  "connector.updated": "audit.action.connectorUpdated",
  "connector.deleted": "audit.action.connectorDeleted",
  "secret.version_created": "audit.action.secretCreated",
  "secret.version_revoked": "audit.action.secretRevoked",
  external_write: "audit.action.externalWrite",
  "execution.aborted": "audit.action.executionAborted",
  "self_healing.scan.completed": "audit.action.healingScanCompleted",
  "patch_candidate.approved": "audit.action.patchApproved",
  "patch_candidate.rejected": "audit.action.patchRejected",
  "patch_candidate.proposed": "audit.action.patchProposed",
  "patch_candidate.auto_applied": "audit.action.patchAutoApplied",
  "patch_candidate.dry_run_requested": "audit.action.patchDryRun",
  "patch_candidate.closed_inapplicable": "audit.action.patchClosedInapplicable",
  "skill_candidate.approved": "audit.action.skillApproved",
  "skill_candidate.rejected": "audit.action.skillRejected",
  "skill_candidate.proposed": "audit.action.skillProposed",
  "skill_candidate.superseded": "audit.action.skillSuperseded",
  "skill_candidate.context_recorded": "audit.action.skillContextRecorded",
  "workflow.created": "audit.action.workflowCreated",
  "workflow.updated": "audit.action.workflowUpdated",
  "execution.started": "audit.action.executionStarted",
  "execution.completed": "audit.action.executionCompleted",
  "schedule.admission.changed": "audit.action.scheduleAdmissionChanged",
  "connector.invoked": "audit.action.connectorInvoked",
  "credential.accessed": "audit.action.credentialAccessed",
  "api_key.used": "audit.action.apiKeyUsed",
  "chat.message.sent": "audit.action.chatMessageSent",
  "session.issued": "audit.action.sessionIssued",
  "connector.mcp_handshake_ok": "audit.action.connectorHandshakeOk",
  "conversation.created": "audit.action.conversationCreated",
  "credential.oauth2_refreshed": "audit.action.credentialRefreshed",
  "credential.rotated": "audit.action.credentialRotated",
  "file.downloaded": "audit.action.fileDownloaded",
  "mcp_oauth.code_issued": "audit.action.oauthCodeIssued",
  "mcp_oauth.consent_denied": "audit.action.oauthConsentDenied",
  "mcp_oauth.consent_granted": "audit.action.oauthConsentGranted",
  "mcp_oauth.token_issued": "audit.action.oauthTokenIssued",
  "mcp_oauth.token_revoked": "audit.action.oauthTokenRevoked",
  "mcp_oauth.token_used": "audit.action.oauthTokenUsed",
  "mcp_oauth.client_disabled": "audit.action.oauthClientDisabled",
  "mcp_oauth.client_retired": "audit.action.oauthClientRetired",
  "mcp_oauth.client_reactivated": "audit.action.oauthClientReactivated",
  "settings.changed": "audit.action.settingsChanged",
  "user.logged_in": "audit.action.userLoggedIn",
  "webhook.inbound.received": "audit.action.webhookReceived",
  "webhook.inbound.denied": "audit.action.webhookDenied",
  "webhook.inbound.created": "audit.action.webhookCreated",
  "webhook.inbound.slug_reassigned": "audit.action.webhookSlugReassigned",
  "connection.created": "audit.action.connectionCreated",
  "connection.renewed": "audit.action.connectionRenewed",
  "connection.failed": "audit.action.connectionFailed",
  "connection.refreshed": "audit.action.connectionRefreshed",
  "connection.refresh_failed": "audit.action.connectionRefreshFailed",
  "connection.disconnected": "audit.action.connectionDisconnected",
  "secret.version_prepared": "audit.action.secretPrepared",
  "secret.version_approved": "audit.action.secretApproved",
  "secret.version_rejected": "audit.action.secretRejected",
  "engine.restart.requested": "audit.action.engineRestartRequested",
  "engine.restart.completed": "audit.action.engineRestartCompleted",
  "engine.restart.failed": "audit.action.engineRestartFailed",
  "conversation.run_workflow": "audit.action.conversationRanWorkflow",
  "tool_policy.confirmation_required": "audit.action.toolPolicyConfirmationRequired",
  "credential.updated": "audit.action.credentialUpdated",
  "settings.revision_saved": "audit.action.settingsRevisionSaved",
  "settings.revision_activated": "audit.action.settingsRevisionActivated",
  "schedule.trigger.fired": "audit.action.scheduleTriggerFired",
  "llm.invocation": "audit.action.llmInvocation",
  "wait.started": "audit.action.waitStarted",
  "wait.completed": "audit.action.waitCompleted",
  "webhook.trigger.failed_verification": "audit.action.webhookVerificationFailed",
};

export type AuditActionLabel =
  | { kind: "named"; key: TranslationKey }
  | { kind: "machine"; value: string };

export function auditActionLabel(action: string): AuditActionLabel {
  const key = ACTION_KEYS[action];
  return key ? { kind: "named", key } : { kind: "machine", value: action };
}

export function auditSearchActions(needle: string, t: Translate): string[] {
  const term = needle.trim().toLowerCase();
  if (!term) return [];
  return Object.entries(ACTION_KEYS)
    .filter(([action, key]) => action.includes(term) || t(key).toLowerCase().includes(term))
    .map(([action]) => action);
}

export function searchedActionParams(
  params: Readonly<Record<string, string>>,
  searched: readonly string[] | null,
): Record<string, string> | null {
  if (searched === null) return { ...params };
  const allowed = params.action ? params.action.split(",") : null;
  const actions = allowed ? searched.filter((action) => allowed.includes(action)) : searched;
  return actions.length > 0 ? { ...params, action: actions.join(",") } : null;
}

export function namedActionCount(): number {
  return Object.keys(ACTION_KEYS).length;
}

export const DECISION_ACTIONS = [
  "patch_candidate.approved",
  "patch_candidate.rejected",
  "skill_candidate.approved",
  "skill_candidate.rejected",
  "approval.granted",
  "approval.approved",
  "approval.rejected",
  "approval.declined",
  "workflow.authority_granted",
  "workflow.authority_revoked",
  "policy.denied",
  "approval.dispatch_denied",
  "execution.boundary_refused",
  "rbac.role_created",
  "rbac.role_deleted",
  "rbac.permission_granted",
  "rbac.permission_revoked",
  "rbac.user_role_assigned",
  "rbac.user_role_revoked",
  "user.created",
  "user.deleted",
  "user.role_changed",
  "api_key.issued",
  "api_key.revoked",
  "workflow.deleted",
  "workflow.version_restored",
  "knowledge_source.restored",
  "schedule.created",
  "schedule.deleted",
  "connector.deleted",
  "secret.version_created",
  "secret.version_revoked",
  "settings.changed",
] as const;

export type AuditScope = "all" | "decisions" | "operations";

export function isAuditScope(value: unknown): value is AuditScope {
  return value === "all" || value === "decisions" || value === "operations";
}

export function auditScopeParams(scope: AuditScope): Record<string, string> {
  if (scope === "decisions") return { action: DECISION_ACTIONS.join(",") };
  if (scope === "operations") return { actor_type: "system" };
  return {};
}

export function auditTraceFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("trace_id")?.trim() ?? "";
  if (!raw || raw.length > 128 || !/^[\w-]+$/.test(raw)) return null;
  return raw;
}

export interface AuditLinkFilter {
  resourceType: string | null;
  resourceId: string | null;
  traceId: string | null;
  scope: AuditScope | null;
  actions: string[];
  tsFrom: string | null;
  tsTo: string | null;
}

const MAX_LINKED_ACTIONS = 32;
const ACTION_TOKEN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

export function auditActionsFromUrl(search: string): string[] {
  const raw = new URLSearchParams(search).get("action") ?? "";
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && token.length <= 96 && ACTION_TOKEN.test(token));
  return [...new Set(tokens)].slice(0, MAX_LINKED_ACTIONS);
}

const AUDIT_RESULTS = ["success", "denied", "error"] as const;
export type AuditResultFilter = (typeof AUDIT_RESULTS)[number];

export function auditResultFromUrl(search: string): AuditResultFilter | null {
  const raw = new URLSearchParams(search).get("result");
  return (AUDIT_RESULTS as readonly string[]).includes(raw ?? "")
    ? (raw as AuditResultFilter)
    : null;
}

export function auditFilterFromUrl(search: string): AuditLinkFilter {
  const params = new URLSearchParams(search);
  const resourceType = identifierParam(params, "resource_type");
  const scope = params.get("scope");
  return {
    resourceType,
    resourceId: resourceType ? identifierParam(params, "resource_id") : null,
    traceId: auditTraceFromUrl(search),
    scope: isAuditScope(scope) ? scope : null,
    actions: auditActionsFromUrl(search),
    tsFrom: instantParam(params, "ts_from"),
    tsTo: instantParam(params, "ts_to"),
  };
}

export function auditLinkParams(filter: AuditLinkFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.resourceType) params.resource_type = filter.resourceType;
  if (filter.resourceId) params.resource_id = filter.resourceId;
  if (filter.traceId) params.trace_id = filter.traceId;
  if (filter.actions.length > 0) params.action = filter.actions.join(",");
  if (filter.tsFrom) params.ts_from = filter.tsFrom;
  if (filter.tsTo) params.ts_to = filter.tsTo;
  return params;
}

export const AUDIT_LINK_KEYS = {
  resource: ["resource_type", "resource_id"],
  trace: ["trace_id"],
  actions: ["action"],
  window: ["ts_from", "ts_to"],
} as const;

export const NO_AUDIT_LINK: AuditLinkFilter = {
  resourceType: null,
  resourceId: null,
  traceId: null,
  scope: null,
  actions: [],
  tsFrom: null,
  tsTo: null,
};

export function isAuditEntry(value: unknown): value is AuditEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.ts === "string" &&
    typeof candidate.action === "string"
  );
}

export type AuditEvidenceKind = "before" | "after";

export interface AuditEvidenceBlock {
  kind: AuditEvidenceKind;
  text: string;
}

function formatSnapshot(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function auditEvidenceBlocks(
  entry: Pick<AuditEntry, "before" | "after">,
): AuditEvidenceBlock[] {
  const blocks: AuditEvidenceBlock[] = [];
  for (const kind of ["before", "after"] as const) {
    const value = entry[kind];
    if (value === null || value === undefined) continue;
    blocks.push({ kind, text: formatSnapshot(value) });
  }
  return blocks;
}

export interface AuditMetadataFact {
  key: string;
  label: string;
  value: string;
  href: string | null;
}

type MetadataReference = {
  label: TranslationKey;
  open: TranslationKey;
  href(id: string): string;
  names?: keyof NameIndex;
};

const METADATA_REFERENCES: Readonly<Record<string, MetadataReference>> = {
  workflow_id: {
    label: "audit.meta.workflow",
    open: "audit.meta.openWorkflow",
    href: workflowHref,
    names: "workflow",
  },
  connector_id: {
    label: "audit.meta.connector",
    open: "audit.meta.openConnector",
    href: connectorHref,
    names: "connector",
  },
  execution_id: { label: "audit.meta.run", open: "audit.detail.openRun", href: runHref },
  conversation_id: {
    label: "audit.meta.conversation",
    open: "audit.meta.openConversation",
    href: conversationHref,
  },
};

const METADATA_VALUES: Readonly<Record<string, TranslationKey>> = {
  slug: "audit.meta.slug",
  name: "audit.meta.name",
  version: "audit.meta.version",
  environment: "audit.meta.environment",
  scope: "audit.meta.scope",
  status: "audit.meta.status",
  chunk_count: "audit.meta.chunkCount",
  count: "audit.meta.count",
};

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function auditMetadataFacts(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
  t: Translate,
  names: NameIndex,
): { facts: AuditMetadataFact[]; rest: string | null } {
  const facts: AuditMetadataFact[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const reference = METADATA_REFERENCES[key];
    const text = scalarText(value);
    if (reference && text) {
      const name = reference.names ? names[reference.names].get(text) : undefined;
      facts.push({
        key,
        label: t(reference.label),
        value: name ?? t(reference.open),
        href: reference.href(text),
      });
      continue;
    }
    const label = METADATA_VALUES[key];
    if (label && text) {
      facts.push({ key, label: t(label), value: text, href: null });
      continue;
    }
    rest[key] = value;
  }
  return {
    facts,
    rest: Object.keys(rest).length > 0 ? formatSnapshot(rest) : null,
  };
}

export interface AuditFact {
  label: string;
  value: string | null;
  mono?: boolean;
}

function recordedText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function labelFact(label: string, value: CatalogLabel | null): AuditFact {
  return value
    ? { label, value: value.text, ...(value.machine ? { mono: true } : {}) }
    : { label, value: null };
}

export function auditDetailFacts(
  entry: AuditEntry,
  t: Translate,
  dateTime: FormatDateTime,
  directory: ReadonlyMap<string, string> = new Map(),
): AuditFact[] {
  return [
    { label: t("audit.column.time"), value: dateTime(entry.ts) },
    labelFact(t("audit.column.result"), auditResultLabel(entry.result, t)),
    labelFact(t("audit.column.actor"), auditActorName(entry, directory, t)),
    { label: t("audit.detail.actorId"), value: recordedText(entry.actor_id), mono: true },
    labelFact(t("audit.column.resource"), auditResourceLabel(entry.resource_type, t)),
    { label: t("audit.detail.resourceId"), value: recordedText(entry.resource_id), mono: true },
    labelFact(t("audit.column.reason"), auditReasonLabel(entry.reason, t)),
    { label: t("audit.detail.trace"), value: recordedText(entry.trace_id), mono: true },
    { label: t("audit.detail.ip"), value: recordedText(entry.ip), mono: true },
    { label: t("audit.detail.userAgent"), value: recordedText(entry.user_agent), mono: true },
    { label: t("audit.detail.record"), value: recordedText(entry.id), mono: true },
  ];
}

export function shortIdentifier(value: string): string {
  const looksLikeAnId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
  return looksLikeAnId ? `${value.slice(0, 8)}…` : value;
}
