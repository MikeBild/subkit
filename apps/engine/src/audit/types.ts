import { z } from "zod";
import { RequestSourceSchema } from "../observability/service-metadata.ts";

export const SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000" as const;

export const AuditAction = {
  HOSTED_STORAGE_OBJECT_RECONCILED: "hosted_storage_object.reconciled",
  HOSTED_WORK_ADMITTED: "hosted_work.admitted",
  HOSTED_WORK_STARTED: "hosted_work.started",
  HOSTED_WORK_FINISHED: "hosted_work.finished",
  HOSTED_WORK_RECONCILED: "hosted_work.reconciled",
  TENANT_CREATED: "tenant.created",
  TENANT_UPDATED: "tenant.updated",
  TENANT_DELETED: "tenant.deleted",
  TENANT_DELETION_REQUESTED: "tenant.deletion_requested",
  TENANT_RESTORED: "tenant.restored",
  TENANT_OPERATOR_ASSIGNED: "tenant.operator_assigned",

  USER_CREATED: "user.created",
  USER_INVITED: "user.invited",
  USER_IDENTITY_LINKED: "user.identity_linked",
  USER_LOGGED_IN: "user.logged_in",
  USER_LOGGED_OUT: "user.logged_out",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_PROFILE_UPDATED: "user.profile_updated",
  USER_DELETED: "user.deleted",
  INVITE_REDEEMED: "user_invite.redeemed",
  INVITE_REVOKED: "user_invite.revoked",

  SESSION_ISSUED: "session.issued",
  SESSION_REFRESHED: "session.refreshed",
  SESSION_REVOKED: "session.revoked",

  COCKPIT_INSTALLATION_CREATED: "cockpit_installation.created",
  COCKPIT_INSTALLATION_REVOKED: "cockpit_installation.revoked",
  COCKPIT_PUSH_KEY_PREPARED: "cockpit_push.key_prepared",
  COCKPIT_PUSH_SUBSCRIPTION_UPSERTED: "cockpit_push.subscription_upserted",
  COCKPIT_PUSH_SUBSCRIPTION_REMOVED: "cockpit_push.subscription_removed",

  SYSTEM_ACCOUNT_CREATED: "system_account.created",
  SYSTEM_ACCOUNT_ROLE_CHANGED: "system_account.role_changed",
  SYSTEM_ACCOUNT_DELETED: "system_account.deleted",

  API_KEY_ISSUED: "api_key.issued",
  API_KEY_ROTATED: "api_key.rotated",
  API_KEY_REVOKED: "api_key.revoked",
  API_KEY_USED: "api_key.used",
  API_KEY_TOKEN_EXCHANGED: "api_key.token_exchanged",

  PORTAL_TOKEN_ISSUED: "portal_token.issued",
  PORTAL_TOKEN_REVOKED: "portal_token.revoked",

  POLICY_CHANGED: "policy.changed",
  POLICY_DENIED: "policy.denied",
  BEFORE_REQUEST_HOOK_CHANGED: "before_request_hook.changed",

  CREDENTIAL_CREATED: "credential.created",
  CREDENTIAL_UPDATED: "credential.updated",
  CREDENTIAL_ROTATED: "credential.rotated",
  CREDENTIAL_DELETED: "credential.deleted",
  CREDENTIAL_ENVIRONMENT_PROMOTED: "credential.environment_promoted",

  CONNECTOR_CREATED: "connector.created",
  CONNECTOR_UPDATED: "connector.updated",
  CONNECTOR_DELETED: "connector.deleted",
  CONNECTOR_ENVIRONMENT_PROMOTED: "connector.environment_promoted",
  CONNECTOR_DOCS_INGESTED: "connector.docs_ingested",
  CONNECTOR_DOCS_CLEARED: "connector.docs_cleared",
  CONNECTOR_SAVED_OVERRIDE: "connector.saved_override",
  CONNECTOR_DISCOVERED: "connector.discovered",
  CONNECTOR_REAUTH_REQUESTED: "connector.reauth_requested",
  CONNECTOR_REAUTH_CLEARED: "connector.reauth_cleared",
  CONNECTOR_CIRCUIT_RESET: "connector.circuit_reset",
  CONNECTOR_HEALTH_CHANGED: "connector.health_changed",
  WORKFLOW_HEALTH_CHANGED: "workflow.health_changed",

  WORKFLOW_CREATED: "workflow.created",
  WORKFLOW_UPDATED: "workflow.updated",
  WORKFLOW_DELETED: "workflow.deleted",
  WORKFLOW_VERSION_RESTORED: "workflow.version_restored",
  WORKFLOW_AUTHORITY_GRANTED: "workflow.authority_granted",
  WORKFLOW_AUTHORITY_REVOKED: "workflow.authority_revoked",
  WORKFLOW_AUTHORITY_INHERITED: "workflow.authority_inherited",
  WORKFLOW_COMMITTED_OVERRIDE: "workflow.committed_override",
  WORKFLOW_SCHEDULE_NOT_BOUND: "workflow.schedule_not_bound",
  WORKFLOW_PREVIEW_AUTO_REPAIRED: "workflow.preview_auto_repaired",
  DRAFT_SPEC_UPDATED: "draft.spec.updated",

  EXECUTION_BOUNDARY_REFUSED: "execution.boundary_refused",

  EXECUTION_QUEUED: "execution.queued",
  EXECUTION_STARTED: "execution.started",
  APPROVAL_DISPATCH_RESERVED: "approval.dispatch_reserved",
  APPROVAL_EXECUTION_BOUND: "approval.execution_bound",
  APPROVAL_DISPATCH_DENIED: "approval.dispatch_denied",
  EXECUTION_ABORT_REQUESTED: "execution.abort_requested",
  EXECUTION_FAILED: "execution.failed",
  EXECUTION_COMPLETED: "execution.completed",
  EXECUTION_ABORTED: "execution.aborted",
  EXECUTION_AUTO_RETRIED: "execution.auto_retried",
  EXECUTION_CRASH_RECOVERED: "execution.crash_recovered",

  STATE_READ: "state.read",
  STATE_WRITE: "state.write",

  WAIT_STARTED: "wait.started",
  WAIT_COMPLETED: "wait.completed",
  WAIT_ABANDONED: "wait.abandoned",

  SCHEDULER_SWEEP_CLAIMED: "scheduler.sweep_claimed",
  SCHEDULER_SWEEP_RENEWED: "scheduler.sweep_renewed",
  SCHEDULER_SWEEP_PROGRESSED: "scheduler.sweep_progressed",
  SCHEDULER_SWEEP_RELEASED: "scheduler.sweep_released",
  SCHEDULER_SWEEP_COMPLETED: "scheduler.sweep_completed",
  SCHEDULER_SWEEP_CADENCE_CLAIMED: "scheduler.sweep_cadence_claimed",
  SCHEDULER_SWEEP_QUEUE_ADMITTED: "scheduler.sweep_queue_admitted",
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

  PATCH_CANDIDATE_PREPARED: "patch_candidate.prepared",
  PATCH_CANDIDATE_PROPOSED: "patch_candidate.proposed",
  PATCH_CANDIDATE_AUTO_APPLIED: "patch_candidate.auto_applied",
  PATCH_CANDIDATE_APPROVED: "patch_candidate.approved",
  PATCH_CANDIDATE_REJECTED: "patch_candidate.rejected",
  PATCH_CANDIDATE_DRY_RUN_REQUESTED: "patch_candidate.dry_run_requested",
  PATCH_CANDIDATE_CLOSED_INAPPLICABLE: "patch_candidate.closed_inapplicable",

  SELF_HEALING_SCAN_TRIGGERED: "self_healing.scan.triggered",
  SELF_HEALING_SCAN_COMPLETED: "self_healing.scan.completed",

  RISK_SIGNAL_RAISED: "operator.risk_signal_raised",

  RISK_SIGNAL_CLEARED: "operator.risk_signal_cleared",

  SUBSCRIPTION_CREATED: "subscription.created",
  SUBSCRIPTION_UPDATED: "subscription.updated",
  SUBSCRIPTION_DELETED: "subscription.deleted",

  WEBHOOK_INBOUND_CREATED: "webhook.inbound.created",
  WEBHOOK_INBOUND_DELETED: "webhook.inbound.deleted",
  WEBHOOK_INBOUND_RECEIVED: "webhook.inbound.received",
  WEBHOOK_INBOUND_DENIED: "webhook.inbound.denied",
  WEBHOOK_INBOUND_SLUG_REASSIGNED: "webhook.inbound.slug_reassigned",
  WEBHOOK_OUTBOUND_DELIVERED: "webhook.outbound.delivered",
  WEBHOOK_OUTBOUND_FAILED: "webhook.outbound.failed",
  WEBHOOK_OUTBOUND_REPLAYED: "webhook.outbound.replayed",
  TRANSACTIONAL_MAIL_RESERVED: "transactional_mail.reserved",
  TRANSACTIONAL_MAIL_SETTLED: "transactional_mail.settled",

  EVENT_EMITTED: "event.emitted",

  CHAT_WORKSPACE_INSTALLED: "chat_workspace.installed",
  CHAT_WORKSPACE_REMOVED: "chat_workspace.removed",
  CHAT_WORKSPACE_HYDRATE_SKIPPED: "chat_workspace.hydrate_skipped",
  CHAT_IDENTITY_LINKED: "chat_identity.linked",
  CHAT_IDENTITY_UNLINKED: "chat_identity.unlinked",
  CHAT_MESSAGE_RECEIVED: "chat.message.received",
  CHAT_MESSAGE_DENIED: "chat.message.denied",
  CHAT_MESSAGE_SENT: "chat.message.sent",
  CHAT_DEDUP_PRUNED: "chat.dedup.pruned",

  NOTIFICATION_CHANNEL_CREATED: "notification_channel.created",
  NOTIFICATION_CHANNEL_UPDATED: "notification_channel.updated",
  NOTIFICATION_CHANNEL_DELETED: "notification_channel.deleted",
  NOTIFICATION_RULE_CREATED: "notification_rule.created",
  NOTIFICATION_RULE_UPDATED: "notification_rule.updated",
  NOTIFICATION_RULE_DELETED: "notification_rule.deleted",
  NOTIFICATION_RULE_TESTED: "notification_rule.tested",

  AUTH_PROVIDER_ADDED: "auth_provider.added",
  AUTH_PROVIDER_REMOVED: "auth_provider.removed",
  AUTH_PROVIDER_REORDERED: "auth_provider.reordered",
  AUTH_PROVIDER_CHANGED: "auth_provider.changed",

  PRODUCT_ADDED: "product.added",
  PRODUCT_REMOVED: "product.removed",
  PRODUCT_CHANGED: "product.changed",

  DATA_EXPORTED: "data.exported",
  DATA_IMPORTED: "data.imported",

  CONVERSATION_CREATED: "conversation.created",
  CONVERSATION_FORKED: "conversation.forked",
  CONVERSATION_COMPLETED: "conversation.completed",
  CONVERSATION_CANCELLED: "conversation.cancelled",
  CONVERSATION_COMMITTED: "conversation.committed",
  CONVERSATION_COMPACTED: "conversation.compacted",
  CONVERSATION_UPDATED: "conversation.updated",
  CONVERSATION_MEMORY_INJECTED: "conversation.memory_injected",
  CONVERSATION_RESUMED: "conversation.resumed",
  CONVERSATION_HIDDEN: "conversation.hidden",
  CONVERSATION_UNHIDDEN: "conversation.unhidden",
  CONVERSATION_DELETED: "conversation.deleted",
  CONVERSATION_SKILL_LOADED: "conversation.skill_loaded",
  CONVERSATION_ANSWER_CITED: "conversation.answer_cited",
  CONVERSATION_TURN_CHANGED: "conversation.turn_changed",
  CONVERSATION_TURN_FAILED: "conversation.turn_failed",
  CONVERSATION_PROBE_CONNECTOR: "conversation.probe_connector",
  CONVERSATION_DRY_RUN_TRANSFORM: "conversation.dry_run_transform",
  CONVERSATION_PALETTE_SURFACE_ENFORCED: "conversation.palette_surface_enforced",

  FILE_DELETED: "file.deleted",
  FILE_CREATED: "file.created",
  FILE_BATCH_CREATED: "file.batch_created",
  FILE_FINALIZED: "file.finalized",
  FILE_UPLOAD_RECEIVED: "file.upload_received",
  FILE_DOWNLOADED: "file.downloaded",
  FILE_LINK_ADDED: "file.link_added",
  FILE_LINK_REMOVED: "file.link_removed",
  FILE_REPLACED: "file.replaced",
  FILE_RENAMED: "file.renamed",
  FILE_SCAN_COMPLETED: "file.scan_completed",

  SK_CLI_LOGIN: "sk_cli.login",
  SK_CLI_LOGOUT: "sk_cli.logout",
  SK_CLI_TENANT_SWITCHED: "sk_cli.tenant_switched",
  SK_CLI_INBOX_ACKED: "sk_cli.inbox_acked",
  NOTIFICATION_INBOX_PRUNED: "notification.inbox_pruned",

  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_GRANTED: "approval.granted",
  APPROVAL_DECLINED: "approval.declined",
  APPROVAL_APPROVED: "approval.approved",
  APPROVAL_REJECTED: "approval.rejected",
  APPROVAL_EXPIRED_PRUNED: "approval.expired_pruned",
  APPROVAL_GRANT_ABANDONED: "approval.grant_abandoned",
  ELICITATION_DEMOTED_TO_PORTAL: "elicitation.demoted_to_portal",
  ELICITATION_EXPIRED: "elicitation.expired",

  CATALOG_METADATA_UPDATED: "catalog_metadata.updated",
  CATALOG_METADATA_GENERATED: "catalog_metadata.generated",
  CATALOG_CATEGORY_RENAMED: "catalog_category.renamed",

  KNOWLEDGE_SOURCE_CREATED: "knowledge_source.created",
  KNOWLEDGE_SOURCE_UPDATED: "knowledge_source.updated",
  KNOWLEDGE_SOURCE_DELETED: "knowledge_source.deleted",
  KNOWLEDGE_SOURCE_INGESTED: "knowledge_source.ingested",
  KNOWLEDGE_SOURCE_REFRESHED: "knowledge_source.refreshed",
  KNOWLEDGE_SOURCE_ANALYZED: "knowledge_source.analyzed",
  KNOWLEDGE_SOURCE_RESTORED: "knowledge_source.restored",
  KNOWLEDGE_SOURCE_CANDIDATES_SYNTHESIZED: "knowledge_source.candidates_synthesized",

  INTAKE_DEFAULT_CATEGORY_UPDATED: "intake_default_category.updated",
  INTAKE_ITEM_COLLECTED: "intake_item.collected",
  INTAKE_ITEM_UPDATED: "intake_item.updated",
  INTAKE_ITEM_EVIDENCE_APPENDED: "intake_item.evidence_appended",
  INTAKE_PROPOSAL_CREATED: "intake_proposal.created",
  INTAKE_PROPOSAL_REVISED: "intake_proposal.revised",
  INTAKE_PROPOSAL_CONFIRMED: "intake_proposal.confirmed",
  INTAKE_PROPOSAL_REJECTED: "intake_proposal.rejected",

  DISCOVERY_RUN_CREATED: "discovery.run_created",
  DISCOVERY_RUN_COMPLETED: "discovery.run_completed",
  DISCOVERY_RUN_FAILED: "discovery.run_failed",
  DISCOVERY_ARTIFACT_PROPOSED: "discovery.artifact_proposed",
  DISCOVERY_ARTIFACT_APPROVED: "discovery.artifact_approved",
  DISCOVERY_ARTIFACT_REJECTED: "discovery.artifact_rejected",
  DISCOVERY_ARTIFACT_SUPERSEDED: "discovery.artifact_superseded",

  SKILL_CANDIDATE_PROPOSED: "skill_candidate.proposed",
  SKILL_CANDIDATE_CONTEXT_RECORDED: "skill_candidate.context_recorded",
  SKILL_CANDIDATE_UPDATED: "skill_candidate.updated",
  SKILL_CANDIDATE_APPROVED: "skill_candidate.approved",
  SKILL_CANDIDATE_REJECTED: "skill_candidate.rejected",
  SKILL_CANDIDATE_SUPERSEDED: "skill_candidate.superseded",

  AGENT_SESSION_CAPTURED: "agent_session.captured",

  SYSTEM_STARTUP: "system.startup",

  AUTH_LOGIN_FAILED: "auth.login_failed",
  AUTH_BRUTE_FORCE_DETECTED: "auth.brute_force_detected",
  AUTH_TOKEN_REJECTED: "auth.token_rejected",

  CREDENTIAL_ACCESSED: "credential.accessed",
  CREDENTIAL_OAUTH2_REFRESHED: "credential.oauth2_refreshed",

  LLM_INVOCATION: "llm.invocation",
  LLM_BUDGET_RESERVED: "llm.budget.reserved",
  LLM_BUDGET_SETTLED: "llm.budget.settled",

  CONNECTOR_INVOKED: "connector.invoked",

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

  DOCUMENT_ANALYZED: "document.analyzed",
  CONTENT_PART_SENT: "content_part.sent",
  CAPABILITY_FALLBACK: "capability.fallback",

  CONNECTOR_DRAFT_CREDENTIAL_REJECTED: "connector.draft.credential_rejected",
  TOOL_POLICY_CONFIRMATION_REQUIRED: "tool_policy.confirmation_required",
  TOOL_POLICY_CONFIRM_COLLAPSED_MCP: "tool_policy.confirm_collapsed_mcp",
  TOOL_POLICY_CHANGED: "tool_policy.changed",

  SETTINGS_CHANGED: "settings.changed",
  SETTINGS_REVISION_SAVED: "settings.revision_saved",
  SETTINGS_REVISION_ACTIVATED: "settings.revision_activated",
  SETTINGS_REVISION_RESTART_REQUIRED: "settings.revision_restart_required",
  SETTINGS_REVISION_ACTIVATION_FAILED: "settings.revision_activation_failed",
  SECRET_VERSION_CREATED: "secret.version_created",
  SECRET_VERSION_REVOKED: "secret.version_revoked",
  SECRET_VERSION_PREPARED: "secret.version_prepared",
  SECRET_VERSION_APPROVED: "secret.version_approved",
  SECRET_VERSION_REJECTED: "secret.version_rejected",

  CONNECTION_CREATED: "connection.created",
  CONNECTION_RENEWED: "connection.renewed",
  CONNECTION_FAILED: "connection.failed",
  CONNECTION_REFRESHED: "connection.refreshed",
  CONNECTION_REFRESH_FAILED: "connection.refresh_failed",
  CONNECTION_DISCONNECTED: "connection.disconnected",
  MASTER_KEY_REWRAPPED: "secret.master_key_rewrapped",

  WEBHOOK_TRIGGER_BOUND: "webhook.trigger.bound",
  WEBHOOK_TRIGGER_FIRED: "webhook.trigger.fired",
  WEBHOOK_TRIGGER_FAILED_VERIFICATION: "webhook.trigger.failed_verification",
  WEBHOOK_TRIGGER_UNBOUND: "webhook.trigger.unbound",
  SCHEDULE_TRIGGER_BOUND: "schedule.trigger.bound",
  SCHEDULE_ADMISSION_CHANGED: "schedule.admission.changed",
  SCHEDULE_OCCURRENCE_CLAIMED: "schedule.occurrence_claimed",
  SCHEDULE_OCCURRENCE_RESTORED: "schedule.occurrence_restored",
  SCHEDULE_TRIGGER_FIRED: "schedule.trigger.fired",
  SCHEDULE_TRIGGER_UNBOUND: "schedule.trigger.unbound",

  EXTERNAL_WRITE: "external_write",

  SETUP_COMPLETED: "setup.completed",
  SETUP_FAILED: "setup.failed",

  DIAGNOSTICS_LOGS_TAILED: "diagnostics.logs_tailed",
  DIAGNOSTICS_DRIFT_READ: "diagnostics.drift_read",
  DIAGNOSTICS_VERSION_READ: "diagnostics.version_read",
  DIAGNOSTICS_INTEGRATIONS_READ: "diagnostics.integrations_read",
  ENGINE_UPDATE_INITIATED: "engine.update.initiated",
  ENGINE_UPDATE_COMPLETED: "engine.update.completed",
  ENGINE_UPDATE_FAILED: "engine.update.failed",
  ENGINE_UPDATE_ROLLED_BACK: "engine.update.rolled_back",
  ENGINE_RESTART_REQUESTED: "engine.restart.requested",
  ENGINE_RESTART_COMPLETED: "engine.restart.completed",
  ENGINE_RESTART_FAILED: "engine.restart.failed",

  CONNECTOR_MCP_HANDSHAKE_OK: "connector.mcp_handshake_ok",
  CONNECTOR_MCP_MANIFEST_DRIFT: "connector.mcp_manifest_drift",
  CONNECTOR_MCP_CLIENT_REGISTERED: "connector.mcp_client_registered",
  MCP_EXTERNAL_TOOL_INVOKED: "mcp_external_tool.invoked",
  MCP_EXTERNAL_TOOL_PALETTE_ASSEMBLY_FAILED: "mcp_external_tool.palette_assembly_failed",
  CONNECTOR_MCP_AUTHORIZATION_STARTED: "connector.mcp_authorization_started",
  CONNECTOR_MCP_AUTHORIZED: "connector.mcp_authorized",
  CONNECTOR_MCP_AUTHORIZATION_FAILED: "connector.mcp_authorization_failed",

  EXTERNAL_PROVIDER_CALL_SUCCEEDED: "external_provider.call_succeeded",
  EXTERNAL_PROVIDER_CALL_FAILED: "external_provider.call_failed",

  OAUTH_CLIENT_REGISTERED: "oauth_client.registered",
  OAUTH_CLIENT_REGISTRATION_FAILED: "oauth_client.registration_failed",
  CONNECTOR_OAUTH_CALLBACK_FAILED: "connector.oauth.callback_failed",
  CONNECTOR_OAUTH_GRANT_ISSUED: "connector.oauth.grant_issued",
  CONNECTOR_OAUTH_GRANT_CONSUMED: "connector.oauth.grant_consumed",
  CONNECTOR_CREDENTIAL_GRANT_ISSUED: "connector.credential_grant.issued",
  CONNECTOR_CREDENTIAL_GRANT_CONSUMED: "connector.credential_grant.consumed",

  MCP_OAUTH_CLIENT_REGISTERED: "mcp_oauth.client_registered",
  MCP_OAUTH_CODE_ISSUED: "mcp_oauth.code_issued",
  MCP_OAUTH_TOKEN_ISSUED: "mcp_oauth.token_issued",
  MCP_OAUTH_TOKEN_REFRESHED: "mcp_oauth.token_refreshed",
  MCP_OAUTH_TOKEN_REVOKED: "mcp_oauth.token_revoked",
  MCP_OAUTH_CONSENT_GRANTED: "mcp_oauth.consent_granted",
  MCP_OAUTH_CONSENT_DENIED: "mcp_oauth.consent_denied",
  MCP_OAUTH_TOKEN_USED: "mcp_oauth.token_used",
  MCP_OAUTH_DCR_RATE_LIMITED: "mcp_oauth.dcr_rate_limited",
  MCP_OAUTH_EXPIRED_PRUNED: "mcp_oauth.expired_pruned",
  MCP_OAUTH_CLIENT_DISABLED: "mcp_oauth.client_disabled",
  MCP_OAUTH_CLIENT_RETIRED: "mcp_oauth.client_retired",
  MCP_OAUTH_CLIENT_REACTIVATED: "mcp_oauth.client_reactivated",
  MCP_OAUTH_CLIENT_LISTED: "mcp_oauth.client_listed",
  MCP_OAUTH_TOKEN_REJECTED: "mcp_oauth.token_rejected",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export const FILE_AUDIT_ACTIONS: ReadonlySet<AuditActionValue> = new Set([
  AuditAction.FILE_CREATED,
  AuditAction.FILE_BATCH_CREATED,
  AuditAction.FILE_FINALIZED,
  AuditAction.FILE_UPLOAD_RECEIVED,
  AuditAction.FILE_DOWNLOADED,
  AuditAction.FILE_DELETED,
  AuditAction.FILE_LINK_ADDED,
  AuditAction.FILE_LINK_REMOVED,
  AuditAction.FILE_SCAN_COMPLETED,
  AuditAction.FILE_REPLACED,
  AuditAction.FILE_RENAMED,
]);

export type KnownAuditActorType = "user" | "system_account" | "system";
export type AuditActorType = KnownAuditActorType | "unknown";
export type AuditResult = "success" | "denied" | "error";

export const ConversationForkedMetadataSchema = z.object({
  forked_from: z.string().uuid(),
  anchor_message_id: z.string().uuid(),
  copied_message_count: z.number().int().nonnegative(),
  tool_calls_omitted: z.boolean(),
  elicitations_omitted: z.boolean(),
  truncated: z.boolean(),
  source_message_count: z.number().int().nonnegative(),
  copy_cap: z.number().int().positive(),
  request_source: RequestSourceSchema,
});
export type ConversationForkedMetadata = z.infer<typeof ConversationForkedMetadataSchema>;

export const ConversationDeletedMetadataSchema = z.object({
  conversation_id: z.string().uuid(),
  title: z.string().nullable(),
  owner_id: z.string().uuid().nullable(),
  message_count: z.number().int().nonnegative(),
  file_links_removed: z.number().int().nonnegative(),
  request_source: RequestSourceSchema,
});
export type ConversationDeletedMetadata = z.infer<typeof ConversationDeletedMetadataSchema>;

export const ToolPolicyChangedMetadataSchema = z.object({
  tool: z.string().min(1),
  mode: z
    .union([
      z.literal("no_confirm"),
      z.literal("confirm_before_execution"),
      z.literal("confirm_after_execution"),
    ])
    .nullable(),
  prior_mode: z
    .union([
      z.literal("no_confirm"),
      z.literal("confirm_before_execution"),
      z.literal("confirm_after_execution"),
    ])
    .nullable(),
  request_source: RequestSourceSchema,
});
export type ToolPolicyChangedMetadata = z.infer<typeof ToolPolicyChangedMetadataSchema>;

export const ToolDispatchPolicyDeniedMetadataSchema = z.object({
  tool: z.string().min(1),
  canonical_tool: z.string().min(1),
  via: z.string().min(1),
  request_source: RequestSourceSchema,
  permission: z.string().min(1),
  args_hash: z.string().regex(/^[0-9a-f]{64}$/),
  approval_id: z.string().uuid().optional(),
  rbac_resource_type: z.string().min(1).optional(),
  rbac_resource_id: z.string().min(1).optional(),
});
export type ToolDispatchPolicyDeniedMetadata = z.infer<
  typeof ToolDispatchPolicyDeniedMetadataSchema
>;

export const DiagnosticsLogsTailedMetadataSchema = z.object({
  mode: z.union([z.literal("json"), z.literal("stream")]),
  returned: z.number().int().nonnegative().optional(),
  since_ms: z.number().int().nonnegative().optional(),
  module_filter: z.string().optional(),
  action_filter: z.string().optional(),
  level_filter: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
});
export type DiagnosticsLogsTailedMetadata = z.infer<typeof DiagnosticsLogsTailedMetadataSchema>;

export const DiagnosticsDriftReadMetadataSchema = z.object({
  embedded: z.number().int().nonnegative(),
  db: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  historical: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});
export type DiagnosticsDriftReadMetadata = z.infer<typeof DiagnosticsDriftReadMetadataSchema>;

export const DiagnosticsVersionReadMetadataSchema = z.object({
  engine_version: z.string(),
  latest_version: z.string().optional(),
  update_available: z.boolean(),
  schema_drift: z.boolean(),
});
export type DiagnosticsVersionReadMetadata = z.infer<typeof DiagnosticsVersionReadMetadataSchema>;

export const DiagnosticsIntegrationsReadMetadataSchema = z.object({
  connectors_total: z.number().int().nonnegative(),
  connectors_attention: z.number().int().nonnegative(),
  workflows_attention: z.number().int().nonnegative(),
});
export type DiagnosticsIntegrationsReadMetadata = z.infer<
  typeof DiagnosticsIntegrationsReadMetadataSchema
>;

const SizeBucketSchema = z.enum(["<1KB", "<1MB", "<10MB", "<100MB", ">=100MB"]);

export const FileCreatedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  size_bytes_bucket: SizeBucketSchema,
  content_type: z.string().nullable(),
  filename: z.string().max(255),
  sha256_prefix: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  dedup: z.boolean().optional(),
  request_source: RequestSourceSchema.optional(),
  source: z.string().optional(),
});
export type FileCreatedMetadata = z.infer<typeof FileCreatedMetadataSchema>;

export const FileLinkAddedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  resource_type: z.string(),
  resource_id: z.string().uuid(),
  slug: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  source: z.string().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type FileLinkAddedMetadata = z.infer<typeof FileLinkAddedMetadataSchema>;

export const FileLinkRemovedMetadataSchema = FileLinkAddedMetadataSchema;
export type FileLinkRemovedMetadata = z.infer<typeof FileLinkRemovedMetadataSchema>;

export const FileFinalizedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  status: z.enum(["ready", "failed", "denied"]).optional(),
  size_bytes_bucket: SizeBucketSchema,
  sha256_prefix: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  outcome: z.string().optional(),
  dedup: z.boolean().optional(),
  content_type: z.string().nullable().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type FileFinalizedMetadata = z.infer<typeof FileFinalizedMetadataSchema>;

export const FileDownloadedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  size_bytes_bucket: SizeBucketSchema,
  range: z.boolean().optional(),
  content_type: z.string().nullable().optional(),
  version: z.number().int().positive().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type FileDownloadedMetadata = z.infer<typeof FileDownloadedMetadataSchema>;

export const FileDeletedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  reason: z.string(),
  request_source: RequestSourceSchema.optional(),
});
export type FileDeletedMetadata = z.infer<typeof FileDeletedMetadataSchema>;

export const FileReplacedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  content_type: z.string().nullable().optional(),
  size_bytes_bucket: SizeBucketSchema,
  sha256_prefix: z.string().regex(/^[0-9a-f]{16}$/),
  version: z.number().int().positive().optional(),
  restored_from_version: z.number().int().positive().optional(),
  pruned_versions: z.number().int().positive().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type FileReplacedMetadata = z.infer<typeof FileReplacedMetadataSchema>;

export const FileRenamedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  request_source: RequestSourceSchema.optional(),
});
export type FileRenamedMetadata = z.infer<typeof FileRenamedMetadataSchema>;

export const FileScanCompletedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  verdict: z.string(),
  engine: z.string(),
  signature: z.string().nullable().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type FileScanCompletedMetadata = z.infer<typeof FileScanCompletedMetadataSchema>;

export const FileBatchCreatedMetadataSchema = z.object({
  count: z.number().int().nonnegative(),
  total_size_bytes_bucket: SizeBucketSchema.optional(),
  dedup_hits: z.number().int().nonnegative(),
  request_source: RequestSourceSchema.optional(),
});
export type FileBatchCreatedMetadata = z.infer<typeof FileBatchCreatedMetadataSchema>;

export const FileUploadReceivedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  size_bytes_bucket: SizeBucketSchema,
  source: z.enum(["authenticated_engine_upload"]),
  request_source: RequestSourceSchema.optional(),
});
export type FileUploadReceivedMetadata = z.infer<typeof FileUploadReceivedMetadataSchema>;

export const ContentPartSentMetadataSchema = z.object({
  provider: z.enum(["anthropic", "openai", "gemini"]),
  file_id: z.string().uuid(),
  content_type: z.string(),
  size_bytes_bucket: SizeBucketSchema,
  request_source: RequestSourceSchema.optional(),
});
export type ContentPartSentMetadata = z.infer<typeof ContentPartSentMetadataSchema>;

export const EngineUpdateMetadataSchema = z.object({
  from_version: z.string(),
  to_version: z.string(),
  channel: z.enum(["stable", "beta"]),
  sha256: z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal("")]),
  request_source: z.enum(["self-update", "rollback"]),
  reason: z.string().optional(),
});
export type EngineUpdateMetadata = z.infer<typeof EngineUpdateMetadataSchema>;

export const RiskSignalRaisedMetadataSchema = z.object({
  kind: z.string(),
  severity: z.enum(["warn", "critical"]),
  metric: z.string(),
  value: z.number(),
  threshold: z.number(),
  uptime_s: z.number().optional(),
  request_source: RequestSourceSchema.optional(),
  instance: z.string().optional(),
});
export type RiskSignalRaisedMetadata = z.infer<typeof RiskSignalRaisedMetadataSchema>;

export const RiskSignalClearedMetadataSchema = z.object({
  kind: z.string(),
  request_source: RequestSourceSchema.optional(),
  instance: z.string().optional(),
});
export type RiskSignalClearedMetadata = z.infer<typeof RiskSignalClearedMetadataSchema>;

export const UserInvitedMetadataSchema = z.object({
  invite_id: z.string().uuid(),
  user_id: z.string().uuid(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  allowed_workflows: z.array(z.string()).nullable().optional(),
  allowed_connectors: z.array(z.string()).nullable().optional(),
  expires_at: z.string(),
  request_source: RequestSourceSchema.optional(),
});
export type UserInvitedMetadata = z.infer<typeof UserInvitedMetadataSchema>;

export const InviteRedeemedMetadataSchema = z.object({
  invite_id: z.string().uuid(),
  user_id: z.string().uuid(),
  api_key_id: z.string().uuid(),
  prefix: z.string(),
  request_source: RequestSourceSchema.optional(),
});
export type InviteRedeemedMetadata = z.infer<typeof InviteRedeemedMetadataSchema>;

export const UserInviteRevokedMetadataSchema = z.object({
  invite_id: z.string().uuid(),
  user_id: z.string().uuid(),
  prefix: z.string(),
  request_source: RequestSourceSchema.optional(),
});
export type UserInviteRevokedMetadata = z.infer<typeof UserInviteRevokedMetadataSchema>;

export const UserIdentityLinkedMetadataSchema = z.object({
  source: z.string(),
  subject: z.string(),
  email: z.string().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type UserIdentityLinkedMetadata = z.infer<typeof UserIdentityLinkedMetadataSchema>;

export const ChatMessageDeniedMetadataSchema = z.object({
  platform: z.string(),
  workspace_id_native: z.string(),
  event_key: z.string().nullable().optional(),
  kind: z.string(),
  sender_platform_user_id: z.string().nullable().optional(),
  space_display_name: z.string().nullable().optional(),
});
export type ChatMessageDeniedMetadata = z.infer<typeof ChatMessageDeniedMetadataSchema>;

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
