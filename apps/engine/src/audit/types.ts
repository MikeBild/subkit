/**
 * Append-only. No updates. No deletes. Designed for SOC2 / ISO27001 / GDPR
 * compliance. Retention policy is handled by an external archive job — this
 * module does not delete rows.
 */

export const AuditAction = {
  TENANT_CREATED: "tenant.created",
  TENANT_UPDATED: "tenant.updated",
  TENANT_DELETED: "tenant.deleted",

  USER_CREATED: "user.created",
  USER_LOGGED_IN: "user.logged_in",
  USER_LOGGED_OUT: "user.logged_out",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_DELETED: "user.deleted",

  SESSION_ISSUED: "session.issued",
  SESSION_REFRESHED: "session.refreshed",
  SESSION_REVOKED: "session.revoked",

  SYSTEM_ACCOUNT_CREATED: "system_account.created",
  SYSTEM_ACCOUNT_ROLE_CHANGED: "system_account.role_changed",
  SYSTEM_ACCOUNT_DELETED: "system_account.deleted",

  API_KEY_ISSUED: "api_key.issued",
  API_KEY_ROTATED: "api_key.rotated",
  API_KEY_REVOKED: "api_key.revoked",
  API_KEY_USED: "api_key.used",

  PORTAL_TOKEN_ISSUED: "portal_token.issued",
  PORTAL_TOKEN_REVOKED: "portal_token.revoked",

  POLICY_CHANGED: "policy.changed",
  POLICY_DENIED: "policy.denied",
  BEFORE_REQUEST_HOOK_CHANGED: "before_request_hook.changed",

  CREDENTIAL_CREATED: "credential.created",
  CREDENTIAL_UPDATED: "credential.updated",
  CREDENTIAL_ROTATED: "credential.rotated",
  CREDENTIAL_DELETED: "credential.deleted",

  CONNECTOR_CREATED: "connector.created",
  CONNECTOR_UPDATED: "connector.updated",
  CONNECTOR_DELETED: "connector.deleted",
  CONNECTOR_ENVIRONMENT_PROMOTED: "connector.environment_promoted",
  CONNECTOR_DOCS_INGESTED: "connector.docs_ingested",
  CONNECTOR_DOCS_CLEARED: "connector.docs_cleared",

  WORKFLOW_CREATED: "workflow.created",
  WORKFLOW_UPDATED: "workflow.updated",
  WORKFLOW_DELETED: "workflow.deleted",
  WORKFLOW_VERSION_RESTORED: "workflow.version_restored",

  EXECUTION_STARTED: "execution.started",
  EXECUTION_COMPLETED: "execution.completed",
  EXECUTION_ABORTED: "execution.aborted",
  EXECUTION_AUTO_RETRIED: "execution.auto_retried",

  SCHEDULE_CREATED: "schedule.created",
  SCHEDULE_UPDATED: "schedule.updated",
  SCHEDULE_PAUSED: "schedule.paused",
  SCHEDULE_RESUMED: "schedule.resumed",
  SCHEDULE_DELETED: "schedule.deleted",

  SKILL_CREATED: "skill.created",
  SKILL_UPDATED: "skill.updated",
  SKILL_ACTIVATED: "skill.activated",
  SKILL_ARCHIVED: "skill.archived",
  SKILL_DELETED: "skill.deleted",

  PATCH_CANDIDATE_PROPOSED: "patch_candidate.proposed",
  PATCH_CANDIDATE_AUTO_APPLIED: "patch_candidate.auto_applied",
  PATCH_CANDIDATE_APPROVED: "patch_candidate.approved",
  PATCH_CANDIDATE_REJECTED: "patch_candidate.rejected",

  SUBSCRIPTION_CREATED: "subscription.created",
  SUBSCRIPTION_UPDATED: "subscription.updated",
  SUBSCRIPTION_DELETED: "subscription.deleted",

  WEBHOOK_INBOUND_CREATED: "webhook.inbound.created",
  WEBHOOK_INBOUND_DELETED: "webhook.inbound.deleted",
  WEBHOOK_INBOUND_RECEIVED: "webhook.inbound.received",
  WEBHOOK_INBOUND_DENIED: "webhook.inbound.denied",
  WEBHOOK_OUTBOUND_DELIVERED: "webhook.outbound.delivered",
  WEBHOOK_OUTBOUND_FAILED: "webhook.outbound.failed",
  WEBHOOK_OUTBOUND_REPLAYED: "webhook.outbound.replayed",

  EVENT_EMITTED: "event.emitted",

  CHAT_WORKSPACE_INSTALLED: "chat_workspace.installed",
  CHAT_WORKSPACE_REMOVED: "chat_workspace.removed",
  CHAT_IDENTITY_LINKED: "chat_identity.linked",
  CHAT_IDENTITY_UNLINKED: "chat_identity.unlinked",
  CHAT_MESSAGE_RECEIVED: "chat.message.received",
  CHAT_MESSAGE_DENIED: "chat.message.denied",
  CHAT_MESSAGE_SENT: "chat.message.sent",

  NOTIFICATION_CHANNEL_CREATED: "notification_channel.created",
  NOTIFICATION_CHANNEL_UPDATED: "notification_channel.updated",
  NOTIFICATION_CHANNEL_DELETED: "notification_channel.deleted",
  NOTIFICATION_RULE_CREATED: "notification_rule.created",
  NOTIFICATION_RULE_UPDATED: "notification_rule.updated",
  NOTIFICATION_RULE_DELETED: "notification_rule.deleted",

  TUNNEL_REGISTERED: "tunnel.registered",
  TUNNEL_UNREGISTERED: "tunnel.unregistered",
  TUNNEL_DISCONNECTED: "tunnel.disconnected",
  TUNNEL_REQUEST_FORWARDED: "tunnel.request_forwarded",

  AUTH_PROVIDER_ADDED: "auth_provider.added",
  AUTH_PROVIDER_REMOVED: "auth_provider.removed",
  AUTH_PROVIDER_REORDERED: "auth_provider.reordered",

  DATA_EXPORTED: "data.exported",
  DATA_IMPORTED: "data.imported",

  CONVERSATION_CREATED: "conversation.created",
  CONVERSATION_COMPLETED: "conversation.completed",
  CONVERSATION_CANCELLED: "conversation.cancelled",
  CONVERSATION_COMMITTED: "conversation.committed",
  CONVERSATION_COMPACTED: "conversation.compacted",
  CONVERSATION_UPDATED: "conversation.updated",
  CONVERSATION_MEMORY_INJECTED: "conversation.memory_injected",
  CONVERSATION_RESUMED: "conversation.resumed",
  // Direct `probe_connector` tool call — does not materialise a workflow
  // execution, but we audit the outbound request so operators can trace
  // which connectors the LLM poked during an authoring session. Metadata
  // records `url_host` (not the full URL) so audit cardinality stays low
  // and no PII-bearing query strings leak into the log.
  CONVERSATION_PROBE_CONNECTOR: "conversation.probe_connector",
  // One-shot expression evaluator used by `dry_run_transform`. Audit
  // metadata never includes the raw expression (PII risk) — only a
  // 16-char sha256 prefix.
  CONVERSATION_DRY_RUN_TRANSFORM: "conversation.dry_run_transform",

  SK_CLI_LOGIN: "sk_cli.login",
  SK_CLI_LOGOUT: "sk_cli.logout",
  SK_CLI_TENANT_SWITCHED: "sk_cli.tenant_switched",

  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_APPROVED: "approval.approved",
  APPROVAL_REJECTED: "approval.rejected",

  // H2: Knowledge Sources
  KNOWLEDGE_SOURCE_CREATED: "knowledge_source.created",
  KNOWLEDGE_SOURCE_UPDATED: "knowledge_source.updated",
  KNOWLEDGE_SOURCE_DELETED: "knowledge_source.deleted",
  KNOWLEDGE_SOURCE_INGESTED: "knowledge_source.ingested",
  KNOWLEDGE_SOURCE_REFRESHED: "knowledge_source.refreshed",

  // H2.5: Discovery
  DISCOVERY_RUN_CREATED: "discovery.run_created",
  DISCOVERY_RUN_COMPLETED: "discovery.run_completed",
  DISCOVERY_RUN_FAILED: "discovery.run_failed",
  DISCOVERY_ARTIFACT_PROPOSED: "discovery.artifact_proposed",
  DISCOVERY_ARTIFACT_APPROVED: "discovery.artifact_approved",
  DISCOVERY_ARTIFACT_REJECTED: "discovery.artifact_rejected",

  // H3: Self-Improving Skills
  SKILL_CANDIDATE_PROPOSED: "skill_candidate.proposed",
  SKILL_CANDIDATE_UPDATED: "skill_candidate.updated",
  SKILL_CANDIDATE_APPROVED: "skill_candidate.approved",
  SKILL_CANDIDATE_REJECTED: "skill_candidate.rejected",
  SKILL_CANDIDATE_SUPERSEDED: "skill_candidate.superseded",

  SYSTEM_STARTUP: "system.startup",

  RBAC_ROLE_CREATED: "rbac.role_created",
  RBAC_ROLE_UPDATED: "rbac.role_updated",
  RBAC_ROLE_DELETED: "rbac.role_deleted",
  RBAC_ROLE_PERMISSION_GRANTED: "rbac.role_permission_granted",
  RBAC_ROLE_PERMISSION_REVOKED: "rbac.role_permission_revoked",
  RBAC_USER_ROLE_ASSIGNED: "rbac.user_role_assigned",
  RBAC_USER_ROLE_REVOKED: "rbac.user_role_revoked",
  RBAC_GRANT_CREATED: "rbac.grant_created",
  RBAC_GRANT_REVOKED: "rbac.grant_revoked",
  RBAC_GROUP_CREATED: "rbac.group_created",
  RBAC_GROUP_UPDATED: "rbac.group_updated",
  RBAC_GROUP_DELETED: "rbac.group_deleted",
  RBAC_GROUP_MEMBER_ADDED: "rbac.group_member_added",
  RBAC_GROUP_MEMBER_REMOVED: "rbac.group_member_removed",
  RBAC_GROUP_ROLE_ASSIGNED: "rbac.group_role_assigned",
  RBAC_GROUP_ROLE_REVOKED: "rbac.group_role_revoked",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export type AuditActorType = "user" | "system_account" | "system";
export type AuditResult = "success" | "denied" | "error";

export type AuditEntry = {
  id: string;
  ts: Date;
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: AuditActionValue;
  resource_type: string;
  resource_id: string | null;
  result: AuditResult;
  trace_id: string;
  ip: string | null;
  user_agent: string | null;
  before: unknown | null;
  after: unknown | null;
  reason: string | null;
  metadata: Record<string, unknown>;
};
