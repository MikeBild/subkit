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
 * The map is deliberately partial. An action nobody has named yet renders as
 * the engine's own string rather than as "Unbekannt": a raw verb is worse than
 * a German one and far better than a word that claims the log recorded nothing.
 */
const ACTION_KEYS: Record<string, TranslationKey> = {
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
  "execution.boundary_refused": "audit.action.boundaryRefused",
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

export function auditActionKey(action: string): TranslationKey {
  return ACTION_KEYS[action] ?? "audit.action.other";
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
