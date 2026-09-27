import type { TranslationKey } from "@/lib/i18n";

/**
 * Which audited resource types the Cockpit can actually open.
 *
 * An execution is deliberately absent: there is no run detail route, and a
 * link that lands nowhere is worse than plain text.
 */
const RESOURCE_ROUTES: Record<string, string> = {
  workflow: "workflows",
  connector: "connectors",
  knowledge_source: "knowledge",
  skill: "skills",
  file: "files",
  conversation: "chat",
};

export function auditResourceHref(resourceType: string, resourceId: string | null): string | null {
  if (!resourceId) return null;
  const route = RESOURCE_ROUTES[resourceType];
  return route ? `/cockpit/${route}/${encodeURIComponent(resourceId)}` : null;
}

const ACTOR_KEYS: Record<string, TranslationKey> = {
  user: "audit.actor.user",
  system_account: "audit.actor.systemAccount",
  system: "audit.actor.system",
};

export function actorTypeKey(actorType: string): TranslationKey {
  return ACTOR_KEYS[actorType] ?? "common.unknown";
}

const RESOURCE_KEYS: Record<string, TranslationKey> = {
  workflow: "nav.workflows",
  // Both kinds of decision. Without them the resource column of every decision
  // entry read "Unbekannt" — the log HELD the history and could not name it.
  patch_candidate: "decisions.kind.patch",
  skill_candidate: "decisions.kind.skill",
  connector: "resource.connectors.title",
  knowledge_source: "nav.knowledge",
  skill: "nav.skills",
  file: "nav.files",
  conversation: "nav.chat",
  session: "audit.resource.session",
  credential: "permission.resource.credentials",
  setting: "nav.settings",
  webhook_inbound: "audit.resource.inboundWebhook",
  mcp_oauth_client: "audit.resource.oauthClient",
  mcp_oauth_code: "audit.resource.oauthCode",
  mcp_oauth_token: "audit.resource.oauthToken",
  // Notification fanout records chat.message.sent against the delivery, not
  // against a conversation. It has no detail route, but it still needs a
  // human name in the audit table instead of the forbidden "Unbekannt".
  notification_delivery: "nav.notifications",
  execution: "nav.runs",
  api_key: "nav.apiAccess",
  role: "nav.access",
  user: "nav.people",
  settings: "nav.settings",
};

export function resourceTypeKey(resourceType: string): TranslationKey {
  // The audit writer is intentionally extensible and can introduce a new
  // resource before the Cockpit catalogue knows its exact noun. Calling a
  // recorded resource "unknown" is false; retain a truthful neutral label
  // until the precise translation lands.
  return RESOURCE_KEYS[resourceType] ?? "audit.resource.other";
}

/**
 * What an audited action IS, in the reader's language.
 *
 * The column used to render `entry.action` verbatim, so the decision history —
 * which the engine has always recorded — arrived as `patch_candidate.approved`
 * and `skill_candidate.rejected`: present, complete, and unreadable. §8.5 is
 * explicit about this case: where the past reaches the log only as a machine
 * value, the naming and the filter belong IN the log, not the sections back in
 * the queue.
 *
 * The map is deliberately partial, and what happens to the rest matters as
 * much as the map. An action nobody has named yet renders as the engine's own
 * string, marked as a machine value — a raw verb is worse than a German one
 * and far better than a word that claims the log recorded nothing.
 *
 * It did the latter for a long time. The fallback resolved to
 * `audit.action.other`, which reads "Weiterer Vorgang" — semantically the
 * banned "Unbekannt" — while this very comment promised the opposite. On a
 * production installation two of the ten visible rows said it, and the
 * paragraph above described behaviour the code did not have.
 */
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
  "skill_candidate.approved": "audit.action.skillApproved",
  "skill_candidate.rejected": "audit.action.skillRejected",
  "skill_candidate.proposed": "audit.action.skillProposed",
  "skill_candidate.superseded": "audit.action.skillSuperseded",
  "workflow.created": "audit.action.workflowCreated",
  "workflow.updated": "audit.action.workflowUpdated",
  "execution.started": "audit.action.executionStarted",
  "execution.completed": "audit.action.executionCompleted",
  // A dispatch the runtime stopped because it was outside what a person
  // approved. It reads as its own line, not as "other": a trail that lists its
  // permissions and not its refusals cannot answer whether the limit held.
  // Written on the edge only — a schedule that starts being held, or one whose
  // hold clears. Which of the two it is, is the row's own denied/allowed, so
  // one line covers both directions without the list growing a second entry.
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
  "settings.changed": "audit.action.settingsChanged",
  "user.logged_in": "audit.action.userLoggedIn",
  "webhook.inbound.received": "audit.action.webhookReceived",
  "webhook.inbound.denied": "audit.action.webhookDenied",
  "webhook.inbound.created": "audit.action.webhookCreated",
  "connection.created": "audit.action.connectionCreated",
  "connection.renewed": "audit.action.connectionRenewed",
  "connection.failed": "audit.action.connectionFailed",
  "connection.refreshed": "audit.action.connectionRefreshed",
  "connection.refresh_failed": "audit.action.connectionRefreshFailed",
  "connection.disconnected": "audit.action.connectionDisconnected",
  "secret.version_prepared": "audit.action.secretPrepared",
  "secret.version_approved": "audit.action.secretApproved",
  "secret.version_rejected": "audit.action.secretRejected",
};

/**
 * How a row's verb should read.
 *
 * Two shapes, because the caller must be able to tell them apart: a named
 * action is prose, an unnamed one is the engine's own token and has to LOOK
 * like one (§15.2 — the machine value, recognisably as such). Returning a
 * translation key for both is what let the fallback masquerade as a name.
 */
export type AuditActionLabel =
  | { kind: "named"; key: TranslationKey }
  | { kind: "machine"; value: string };

export function auditActionLabel(action: string): AuditActionLabel {
  const key = ACTION_KEYS[action];
  return key ? { kind: "named", key } : { kind: "machine", value: action };
}

/** How many of the engine's verbs this build can name. Read by the coverage guard. */
export function namedActionCount(): number {
  return Object.keys(ACTION_KEYS).length;
}

/**
 * The four verbs that make up the decision history.
 *
 * The engine's `action` filter takes a comma-separated list, so this is one
 * query rather than a client-side sieve over a cursor-paged list — which would
 * have returned short pages and an unusable "next".
 */
export const DECISION_ACTIONS = [
  "patch_candidate.approved",
  "patch_candidate.rejected",
  "skill_candidate.approved",
  "skill_candidate.rejected",
] as const;

export type AuditScope = "all" | "decisions";

export function isAuditScope(value: unknown): value is AuditScope {
  return value === "all" || value === "decisions";
}
