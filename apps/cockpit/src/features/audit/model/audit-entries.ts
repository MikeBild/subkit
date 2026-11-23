import type { components } from "@cli-core/engine-api/openapi";
import {
  absolute,
  connectorHref,
  conversationHref,
  recordHref,
  runHref,
  taskHref,
  workflowHref,
} from "@/app/links";
import type { CatalogResource } from "@/app/route-table";
import {
  auditDetailFacts as coreAuditDetailFacts,
  auditEvidenceBlocks as coreAuditEvidenceBlocks,
  auditMetadataFacts as coreAuditMetadataFacts,
} from "@/features/audit/model/audit-evidence";
import type { Translate, TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

export type { AuditArea, AuditLinkFilter, AuditScope } from "@/features/audit/model/audit-filter";
export {
  AUDIT_AREAS,
  auditActionsFromUrl,
  auditAreaParams,
  auditCorrelationFromUrl,
  auditCountKey,
  auditFilterFromUrl,
  auditLinkParams,
  auditResultFromUrl,
  auditScopeParams,
  auditTraceFromUrl,
  initialAuditFilter,
  isAuditScope,
  normalizedAuditScope,
} from "@/features/audit/model/audit-filter";
export { shortIdentifier } from "@/lib/core/identifier";

type AuditEntry = Omit<components["schemas"]["AuditEntry"], "resource_name"> & {
  resource_name?: string | null;
};
type FormatDateTime = (value: string | Date) => string;

const RESOURCE_ROUTES: Record<string, CatalogResource | "chat" | "runs" | "tasks"> = {
  task: "tasks",
  task_run: "tasks",
  task_grant: "tasks",
  workflow: "workflows",
  connector: "connectors",
  knowledge_source: "knowledge",
  skill: "skills",
  file: "files",
  conversation: "chat",
  execution: "runs",
};

export const LINKED_RESOURCE_TYPES: readonly string[] = Object.keys(RESOURCE_ROUTES);

const RESOURCE_PERMISSIONS: Record<string, string> = {
  workflow: "workflow:read",
  connector: "connector:read",
  knowledge_source: "knowledge:read",
  skill: "skill:read",
  file: "file:read",
  execution: "execution:read",
  conversation: "conversation:read",
  task: "task:read",
  task_run: "task:read",
  task_grant: "task:read",
};

export function auditResourcePermission(resourceType: string): string | null {
  return Object.hasOwn(RESOURCE_PERMISSIONS, resourceType)
    ? (RESOURCE_PERMISSIONS[resourceType] ?? null)
    : null;
}

export function auditResourceHref(
  resourceType: string,
  resourceId: string | null,
  taskId: string | null = null,
): string | null {
  if (!resourceId) return null;
  const route = RESOURCE_ROUTES[resourceType];
  if (!route) return null;
  if (route === "tasks") {
    const task = resourceType === "task" ? resourceId : taskId;
    return task ? absolute(taskHref(task)) : null;
  }
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
  unknown: "audit.actor.unknown",
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
  t: Translate,
): CatalogLabel | null {
  const kind = entry.actor_type?.trim() ?? "";
  const id = entry.actor_id?.trim();
  const shownId =
    id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? `${id.slice(0, 8)}…${id.slice(-12)}`
      : id;
  if (!kind) return shownId ? { text: shownId, machine: true } : null;
  const label = actorTypeLabel(kind, t);
  return { text: shownId ? `${label.text} · ${shownId}` : label.text, machine: label.machine };
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
  execution_authority_expired: "audit.reason.authorityExpired",
  execution_authority_exhausted: "audit.reason.authorityExhausted",
  execution_authority_revoked: "audit.reason.authorityRevoked",
  execution_authority_changed: "audit.reason.authorityChanged",
  input_required: "audit.reason.inputRequired",
  refresh_replayed: "audit.reason.refreshReplayed",
  manual_re_issue: "audit.reason.manualReissue",
  client_retired: "audit.reason.clientRetired",
  authority_covered: "audit.reason.authorityCovered",
  user_instruction: "audit.reason.userInstruction",
  standing_rule: "audit.reason.standingRule",
  question: "audit.reason.taskQuestion",
  approval: "audit.reason.taskApproval",
  no_progress: "audit.reason.taskNoProgress",
  budget: "audit.reason.taskBudget",
  budget_exhausted: "audit.reason.taskBudget",
  question_expired: "audit.reason.taskQuestionExpired",
  turn_stopped: "audit.reason.taskTurnStopped",
  ai_access: "audit.reason.taskAiAccess",
  ai_access_missing: "audit.reason.taskAiAccess",
  grant_required: "audit.reason.taskGrantRequired",
  grant_expired: "audit.reason.taskGrantExpired",
  grant_exhausted: "audit.reason.taskGrantExhausted",
  grant_fingerprint_mismatch: "audit.reason.taskGrantChanged",
  superseded: "audit.reason.taskGrantSuperseded",
  owner_unavailable: "audit.reason.taskOwnerUnavailable",
  previous_run_active: "audit.reason.taskPreviousRunActive",
  paused: "audit.reason.taskPaused",
  owner_request: "audit.reason.taskPausedByOwner",
  admin: "audit.reason.taskPausedByAdmin",
  turn_failed: "audit.reason.taskTurnFailed",
  turn_interrupted: "audit.reason.taskTurnInterrupted",
  start_failed: "audit.reason.taskStartFailed",
  playbook_tampered: "audit.reason.taskPlanTampered",
  playbook_cancelled: "audit.reason.taskPlanCancelled",
  conversation_closed: "audit.reason.taskConversationClosed",
  task_changed: "audit.reason.taskChanged",
  task_archived: "audit.reason.taskRemoved",
  task_deleted: "audit.reason.taskRemoved",
  deadline_exceeded: "audit.reason.taskDeadline",
  turn_limit_reached: "audit.reason.taskTurnLimit",
  check_requested: "audit.reason.taskCheckRequested",
  provider_throttled: "audit.reason.taskProviderThrottled",
  wake: "audit.reason.taskWake",
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
  tool_approval_rule: "audit.resource.toolApprovalRule",
  task: "audit.resource.task",
  task_run: "audit.resource.taskRun",
  task_grant: "audit.resource.taskGrant",
  device_runner: "audit.resource.deviceRunner",
  device_command: "audit.resource.deviceCommand",
  local_confirmation: "audit.resource.localConfirmation",
  local_workspace: "audit.resource.localWorkspace",
  workflow: "audit.resource.workflow",
  patch_candidate: "decisions.kind.patch",
  skill_candidate: "decisions.kind.skill",
  connector: "resource.connectors.title",
  knowledge_source: "nav.knowledge",
  skill: "nav.skills",
  file: "nav.files",
  catalog_category: "catalogMeta.category",
  intake_item: "audit.resource.intakeItem",
  conversation: "nav.chat",
  session: "audit.resource.session",
  user_identity: "audit.resource.userIdentity",
  auth_provider: "settings.auth.providers",
  product: "people.app",
  credential: "permission.resource.credentials",
  vault_item: "permission.resource.vault",
  setting: "nav.settings",
  tenant_branding: "branding.title",
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
  package: "permission.resource.packages",
  schedule: "permission.resource.schedules",
  subscription: "permission.resource.subscriptions",
  inbound_hook: "permission.resource.inboundHooks",
  portal_token: "permission.resource.portalTokens",
  resource_grant: "access.grants",
  group: "access.groups",
  system_account: "audit.actor.systemAccount",
  user_invite: "people.invite.resource",
  workflow_run: "nav.runs",
  runtime_secret: "audit.resource.runtimeSecret",
  chat_workspace: "audit.resource.chatWorkspace",
  chat_identity: "audit.resource.chatIdentity",
  chat_message: "audit.resource.chatMessage",
  chat_events_seen: "audit.resource.chatEventsSeen",
  conversation_elicitation: "audit.resource.conversationQuestion",
  runtime_config_revision: "audit.resource.settingsRevision",
  workflow_schedule: "audit.resource.workflowSchedule",
  scheduler_sweep: "audit.resource.schedulerSweep",
  self_healing_scan: "audit.resource.selfHealingScan",
  engine: "audit.resource.engine",
  discovery_run: "audit.resource.discoveryRun",
  discovery_artifact: "audit.resource.discoveryArtifact",
  tenant: "audit.resource.tenant",
  request_hook: "audit.resource.requestHook",
  notification_rule: "audit.resource.notificationRule",
  notification_channel: "audit.resource.notificationChannel",
  cockpit_installation: "audit.resource.cockpitInstallation",
  desktop_login_code: "audit.resource.desktopLoginCode",
  cockpit_push_key: "audit.resource.cockpitPushKey",
  cockpit_push_subscription: "audit.resource.cockpitPushSubscription",
  llm: "audit.resource.llm",
  extract: "audit.resource.extract",
  workflow_execution_authority: "audit.resource.executionAuthority",
  attention: "audit.resource.attention",
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
  auth_identity: "audit.resource.userIdentity",
  hosted_storage_object: "audit.resource.hostedStorageObject",
  hosted_work: "audit.resource.hostedWork",
  identity_recovery_session: "audit.resource.recoverySession",
  llm_budget: "audit.resource.llmBudget",
};

export function auditResourceLabel(resourceType: string, t: Translate): CatalogLabel {
  return catalogLabel(resourceType, RESOURCE_KEYS[resourceType], t);
}

export const ACTION_KEYS: Record<string, TranslationKey> = {
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
  "workflow.authority_expiry_removed": "audit.action.authorityExpiryRemoved",
  "policy.denied": "audit.action.policyDenied",
  "execution.boundary_refused": "audit.action.boundaryRefused",
  "execution.write_held": "audit.action.writeHeld",
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
  "user.invite_delivery": "audit.action.userInviteDelivery",
  "user.notifications_paused": "audit.action.userNotificationsPaused",
  "user.notifications_resumed": "audit.action.userNotificationsResumed",
  "attention.snoozed": "audit.action.attentionSnoozed",
  "attention.unsnoozed": "audit.action.attentionUnsnoozed",
  "workspace.approval_policy_changed": "audit.action.workspaceApprovalPolicyChanged",
  "workspace.spend_limit_changed": "audit.action.workspaceSpendLimitChanged",
  "workspace.spend_continued": "audit.action.workspaceSpendContinued",
  "execution.budget_parked": "audit.action.executionBudgetParked",
  "workflow.pair_approval_requested": "audit.action.pairApprovalRequested",
  "workflow.pair_approval_approved": "audit.action.pairApprovalApproved",
  "workflow.pair_approval_declined": "audit.action.pairApprovalDeclined",
  "workflow.pair_approval_withdrawn": "audit.action.pairApprovalWithdrawn",
  "workflow.pair_approval_expired": "audit.action.pairApprovalExpired",
  "workflow.pair_approval_stale": "audit.action.pairApprovalStale",
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
  "draft.spec.updated": "audit.action.draftSpecUpdated",
  "knowledge_source.restored": "audit.action.knowledgeRestored",
  "knowledge_source.created": "audit.action.knowledgeCreated",
  "knowledge_source.updated": "audit.action.knowledgeUpdated",
  "knowledge_source.deleted": "audit.action.knowledgeDeleted",
  "knowledge_source.ingested": "audit.action.knowledgeIngested",
  "knowledge_source.refreshed": "audit.action.knowledgeRefreshed",
  "knowledge_source.analyzed": "audit.action.knowledgeAnalyzed",
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
  "workflow.preview_auto_repaired": "audit.action.workflowPreviewAutoRepaired",
  "execution.started": "audit.action.executionStarted",
  "execution.completed": "audit.action.executionCompleted",
  "schedule.admission.changed": "audit.action.scheduleAdmissionChanged",
  "connector.invoked": "audit.action.connectorInvoked",
  "credential.accessed": "audit.action.credentialAccessed",
  "api_key.used": "audit.action.apiKeyUsed",
  "chat.message.sent": "audit.action.chatMessageSent",
  "chat.composer_attachment_staged": "audit.action.chatComposerAttachmentStaged",
  "chat.composer_attachment_removed": "audit.action.chatComposerAttachmentRemoved",
  "chat.composer_attachments_claimed": "audit.action.chatComposerAttachmentsClaimed",
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
  "desktop_login.code_issued": "audit.action.desktopLoginCodeIssued",
  "desktop_login.denied": "audit.action.desktopLoginDenied",
  "desktop_login.completed": "audit.action.desktopLoginCompleted",
  "cockpit_installation.created": "audit.action.installationCreated",
  "cockpit_installation.revoked": "audit.action.installationRevoked",
  "cockpit_push.key_prepared": "audit.action.pushKeyPrepared",
  "cockpit_push.subscription_upserted": "audit.action.pushSubscribed",
  "cockpit_push.subscription_removed": "audit.action.pushUnsubscribed",
  "user.logged_out": "audit.action.userLoggedOut",
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
  "vault.item.created": "audit.action.vaultItemCreated",
  "vault.item.updated": "audit.action.vaultItemUpdated",
  "vault.item.rotated": "audit.action.vaultItemRotated",
  "vault.item.revealed": "audit.action.vaultItemRevealed",
  "vault.item.deleted": "audit.action.vaultItemDeleted",
  "vault.item.used": "audit.action.vaultItemUsed",
  "vault.item.promoted": "audit.action.vaultItemPromoted",
  "vault.item.refreshed": "audit.action.vaultItemRefreshed",
  "settings.revision_saved": "audit.action.settingsRevisionSaved",
  "settings.revision_activated": "audit.action.settingsRevisionActivated",
  "auth_provider.added": "audit.action.authProviderAdded",
  "auth_provider.removed": "audit.action.authProviderRemoved",
  "auth_provider.reordered": "audit.action.authProviderReordered",
  "auth_provider.changed": "audit.action.authProviderChanged",
  "product.added": "audit.action.productAdded",
  "product.removed": "audit.action.productRemoved",
  "product.changed": "audit.action.productChanged",
  "schedule.trigger.fired": "audit.action.scheduleTriggerFired",
  "llm.invocation": "audit.action.llmInvocation",
  "wait.started": "audit.action.waitStarted",
  "wait.completed": "audit.action.waitCompleted",
  "webhook.trigger.failed_verification": "audit.action.webhookVerificationFailed",
  "tool_policy.confirmation_skipped": "audit.action.toolPolicyConfirmationSkipped",
  "tool_approval_rule.created": "audit.action.approvalRuleCreated",
  "tool_approval_rule.dismissed": "audit.action.approvalRuleDismissed",
  "tool_approval_rule.revoked": "audit.action.approvalRuleRevoked",
  "tool_approval_rule.renewed": "audit.action.approvalRuleRenewed",
  "user.setup_updated": "audit.action.userSetupUpdated",
  "task.created": "audit.action.taskCreated",
  "task.updated": "audit.action.taskUpdated",
  "task.deleted": "audit.action.taskDeleted",
  "task.paused": "audit.action.taskPaused",
  "task.resumed": "audit.action.taskResumed",
  "task.authority_granted": "audit.action.taskAuthorityGranted",
  "task.authority_revoked": "audit.action.taskAuthorityRevoked",
  "task.admission.changed": "audit.action.taskAdmissionChanged",
  "task.schedule_claimed": "audit.action.taskScheduleClaimed",
  "task_run.started": "audit.action.taskRunStarted",
  "task_run.waiting": "audit.action.taskRunWaiting",
  "task_run.resumed": "audit.action.taskRunResumed",
  "task_run.result_ready": "audit.action.taskRunResultReady",
  "task_run.completed": "audit.action.taskRunCompleted",
  "task_run.failed": "audit.action.taskRunFailed",
  "task_run.abort_requested": "audit.action.taskRunAbortRequested",
  "task_run.aborted": "audit.action.taskRunAborted",
  "feedback.submitted": "audit.action.feedbackSubmitted",
  "device_runner.enrolled": "audit.action.deviceRunnerEnrolled",
  "device_runner.revoked": "audit.action.deviceRunnerRevoked",
  "device.folder_allowed": "audit.action.deviceFolderAllowed",
  "device.folder_removed": "audit.action.deviceFolderRemoved",
  "device.site_allowed": "audit.action.deviceSiteAllowed",
  "device.site_removed": "audit.action.deviceSiteRemoved",
  "device.app_allowed": "audit.action.deviceAppAllowed",
  "device.app_removed": "audit.action.deviceAppRemoved",
  "device.keep_out_added": "audit.action.deviceKeepOutAdded",
  "device.keep_out_removed": "audit.action.deviceKeepOutRemoved",
  "device_command.completed": "audit.action.deviceCommandCompleted",
  "device_command.refused": "audit.action.deviceCommandRefused",
  "device_command.lost": "audit.action.deviceCommandLost",
  "device.stop": "audit.action.deviceStop",
  "device.screenshot_viewed": "audit.action.deviceScreenshotViewed",
  "local_confirmation.granted": "audit.action.localConfirmationGranted",
  "local_confirmation.declined": "audit.action.localConfirmationDeclined",
  "local_mode.initialized": "audit.action.localModeInitialized",
  "local_backup.created": "audit.action.localBackupCreated",
  "local_backup.restored": "audit.action.localBackupRestored",
  "workspace.moved_to_server": "audit.action.workspaceMovedToServer",
};

type AuditActionLabel = { kind: "named"; key: TranslationKey } | { kind: "machine"; value: string };

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

export function isAuditEntry(value: unknown): value is AuditEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.ts === "string" &&
    typeof candidate.action === "string"
  );
}

type AuditEvidenceKind = "before" | "after";

interface AuditEvidenceBlock {
  kind: AuditEvidenceKind;
  text: string;
}

export function auditEvidenceBlocks(
  entry: Pick<AuditEntry, "before" | "after">,
): AuditEvidenceBlock[] {
  return coreAuditEvidenceBlocks(entry);
}

interface AuditMetadataFact {
  key: string;
  label: string;
  value: string;
  href: string | null;
}

type MetadataReference = {
  label: TranslationKey;
  open: TranslationKey;
  href(id: string): string;
};

const METADATA_REFERENCES: Readonly<Record<string, MetadataReference>> = {
  workflow_id: {
    label: "audit.meta.workflow",
    open: "audit.meta.openWorkflow",
    href: workflowHref,
  },
  connector_id: {
    label: "audit.meta.connector",
    open: "audit.meta.openConnector",
    href: connectorHref,
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

export function auditMetadataFacts(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
  t: Translate,
): { facts: AuditMetadataFact[]; rest: string | null } {
  return coreAuditMetadataFacts(metadata, t, {
    references: METADATA_REFERENCES,
    values: METADATA_VALUES,
  });
}

export function auditDetailFacts(
  entry: AuditEntry,
  t: Translate,
  dateTime: FormatDateTime,
): ReturnType<typeof coreAuditDetailFacts> {
  return coreAuditDetailFacts(entry, t, dateTime, {
    result: (value) => auditResultLabel(value.result, t),
    actor: (value) => auditActorName(value, t),
    resource: (value) => auditResourceLabel(value.resource_type, t),
    reason: (value) => auditReasonLabel(value.reason, t),
  });
}
