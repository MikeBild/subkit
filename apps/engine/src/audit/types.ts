/**
 * Append-only. No updates. No deletes. Designed for SOC2 / ISO27001 / GDPR
 * compliance. Retention policy is handled by an external archive job — this
 * module does not delete rows.
 */

import { z } from "zod";

/**
 * Sentinel UUID used as `tenant_id` for audit rows that are emitted before
 * any real tenant exists — currently the first-run setup wizard
 * (`POST /v1/setup`) which has to write `setup.completed` / `setup.failed`
 * audit rows under SOC2 evidence requirements before the bootstrap
 * transaction creates the operator's first tenant.
 *
 * `audit_log.tenant_id` is intentionally NOT a foreign key into `tenants`
 * (compliance — audit entries must survive tenant deletion), so a synthetic
 * UUID that obviously will never collide with `gen_random_uuid()` output is
 * safe to use here. Audit-log consumers can filter on this constant to
 * separate pre-tenant infrastructure events from per-tenant activity.
 */
export const SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000" as const;

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
  // Saved via save_connector_draft with `force=true` — no successful probe
  // was recorded. Metadata records the probe classification so operators can
  // see why probing was skipped or failed.
  CONNECTOR_SAVED_OVERRIDE: "connector.saved_override",
  // Discovery (introspection / spec-fetch / html-scrape / playwright)
  // completed for a saved connector. Metadata records which strategy
  // produced the result, the endpoint count, and any per-strategy
  // warnings ("openapi-direct 404, llms.txt empty, html-scrape
  // succeeded") — without this the operator only sees a binary
  // "discovered / not discovered" without context.
  CONNECTOR_DISCOVERED: "connector.discovered",

  WORKFLOW_CREATED: "workflow.created",
  WORKFLOW_UPDATED: "workflow.updated",
  WORKFLOW_DELETED: "workflow.deleted",
  WORKFLOW_VERSION_RESTORED: "workflow.version_restored",
  // Committed via save_workflow_draft with `force=true` — no successful preview
  // was recorded. Metadata captures the classification of the most recent
  // preview attempt (if any) so operators can audit why the override was
  // taken.
  WORKFLOW_COMMITTED_OVERRIDE: "workflow.committed_override",

  EXECUTION_STARTED: "execution.started",
  EXECUTION_COMPLETED: "execution.completed",
  EXECUTION_ABORTED: "execution.aborted",
  EXECUTION_AUTO_RETRIED: "execution.auto_retried",
  // Engine boot reaped a `running` execution that had been in-flight for
  // longer than `workflow.timeout_ms × 1.5` (or the env-configured
  // fallback). The row was forced to `timed_out` so the operator can
  // see that the previous engine instance crashed mid-flight.
  EXECUTION_CRASH_RECOVERED: "execution.crash_recovered",

  // Persistent workflow run state (#51): cross-run watermark / cursor
  // reads + writes, tenant-encrypted, scoped to a single workflow.
  // Emitted from the step-runner when a request step declares
  // `state_read` / `state_write`. Both pair with `metadata.key`.
  STATE_READ: "state.read",
  STATE_WRITE: "state.write",

  // Step-level wait checkpoint (#48 SHRUNK). First step-level audit pair
  // in subkit — wait_started fires at step start with the configured
  // sleep_until_ts; wait_completed pairs at step end with `reason`
  // (`timer` for normal completion, `cancelled` for abort, or `recovered`
  // for engine-boot reaper resumes). Both pair with `metadata.step_id`.
  WAIT_STARTED: "wait.started",
  WAIT_COMPLETED: "wait.completed",

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
  NOTIFICATION_RULE_TESTED: "notification_rule.tested",

  AUTH_PROVIDER_ADDED: "auth_provider.added",
  AUTH_PROVIDER_REMOVED: "auth_provider.removed",
  AUTH_PROVIDER_REORDERED: "auth_provider.reordered",

  DATA_EXPORTED: "data.exported",
  DATA_IMPORTED: "data.imported",

  CONVERSATION_CREATED: "conversation.created",
  // W1 of PR #161 review — distinct action so audit-log queries can
  // separate forks (which clone prior tenant content) from greenfield
  // creates. Metadata still carries forked_from / anchor_message_id /
  // copied_message_count.
  CONVERSATION_FORKED: "conversation.forked",
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
  CONVERSATION_ATTACHMENT_CREATED: "conversation.attachment_created",
  CONVERSATION_ATTACHMENT_DELETED: "conversation.attachment_deleted",

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
  // Wave 2: synthesised connector endpoint candidates from a file (README,
  // architecture doc, code dump). Distinct from the regular
  // KNOWLEDGE_SOURCE_REFRESHED action — discovery from files is a
  // different reason code (`file_analysis`) and an LLM call sat behind
  // the row, so operators want to filter it separately.
  KNOWLEDGE_SOURCE_CANDIDATES_SYNTHESIZED: "knowledge_source.candidates_synthesized",

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

  // Authentication failures — SOC 2 CC6.1, GDPR Art. 32
  AUTH_LOGIN_FAILED: "auth.login_failed",
  AUTH_BRUTE_FORCE_DETECTED: "auth.brute_force_detected",
  AUTH_TOKEN_REJECTED: "auth.token_rejected",

  // Credential access forensics — GDPR Art. 32, SOC 2 CC6.7
  CREDENTIAL_ACCESSED: "credential.accessed",
  CREDENTIAL_OAUTH2_REFRESHED: "credential.oauth2_refreshed",

  // LLM usage per tenant — SOC 2 A1, ISO 27001 A.12.4
  LLM_INVOCATION: "llm.invocation",

  // Connector data flows — SOC 2 CC9
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

  // Wave 4: hardened audit surface for the conversation pipeline.
  //
  // - `connector.draft.credential_rejected` — the LLM tried to splice a
  //   credential into the connector draft via `update_connector_draft`.
  //   Wave 2 emitted only a `log.connector.draft.credential_rejected`
  //   structured log; the audit row makes the rejection visible to
  //   compliance tooling that scans `audit_log`.
  // - `tool_policy.confirmation_required` — the per-turn policy
  //   resolver decided a tool call must pause for human confirmation
  //   (env=prod, dangerous tool, inline credential present, etc.).
  //   Operators query this kind to audit policy decisions across
  //   tenants without scraping debug logs.
  CONNECTOR_DRAFT_CREDENTIAL_REJECTED: "connector.draft.credential_rejected",
  TOOL_POLICY_CONFIRMATION_REQUIRED: "tool_policy.confirmation_required",
  // - `tool_policy.changed` — operator overrode the per-tool default
  //   confirmation mode for a conversation (set/clear via the
  //   `/conversations/:id/tool-policies` route, the chat dispatcher's
  //   `/policy` slash command, or programmatically through
  //   `setToolPolicy`). Captures the tool name and the new mode (or
  //   `null` on clear) so compliance can audit who relaxed gating.
  //   Metadata schema is pinned by `ToolPolicyChangedMetadataSchema`
  //   below.
  TOOL_POLICY_CHANGED: "tool_policy.changed",

  // Settings subsystem (apps/engine/src/settings/) — every set writes
  // an audit row with the redacted before/after diff. Secret values
  // are masked (***) so audit consumers never see the live material.
  SETTINGS_CHANGED: "settings.changed",

  // Trigger lifecycle for workflow-bound webhooks + schedules. The
  // `bound` / `unbound` events fire from the workflow save/delete
  // path (see `apps/engine/src/workflows/service.ts`) and reflect the
  // reverse binding into `webhooks_inbound` / `workflows_schedules`.
  // The `fired` / `failed_verification` events are emitted by the
  // executor side (#46 webhook firing, #47 schedule firing) — the
  // enum values are pinned here so downstream filters can be
  // authored ahead of the executor landing.
  WEBHOOK_TRIGGER_BOUND: "webhook.trigger.bound",
  WEBHOOK_TRIGGER_FIRED: "webhook.trigger.fired",
  WEBHOOK_TRIGGER_FAILED_VERIFICATION: "webhook.trigger.failed_verification",
  WEBHOOK_TRIGGER_UNBOUND: "webhook.trigger.unbound",
  SCHEDULE_TRIGGER_BOUND: "schedule.trigger.bound",
  SCHEDULE_TRIGGER_FIRED: "schedule.trigger.fired",
  SCHEDULE_TRIGGER_UNBOUND: "schedule.trigger.unbound",

  // External-system mutation surface — emitted whenever a workflow
  // step performs a write against an outside system (HTTP non-GET,
  // SQL INSERT/UPDATE/DELETE/CALL, S3 PUT/DELETE). Distinct from
  // `CONNECTOR_INVOKED` which covers reads + writes and from
  // `EXECUTION_*` which covers the workflow envelope. Compliance
  // dashboards filter on this to scope SOC2 CC9 evidence to actual
  // outbound mutations.
  EXTERNAL_WRITE: "external_write",

  // Setup wizard outcomes — emitted by the post-install setup flow
  // when a tenant completes the guided onboarding (or aborts after a
  // hard failure). Distinct from the per-step audit actions so
  // operators can chart funnel completion without joining across
  // every individual setup-step event.
  SETUP_COMPLETED: "setup.completed",
  SETUP_FAILED: "setup.failed",

  // `/v1/diagnostics/logs` and `/v1/diagnostics/logs/stream` — emitted
  // each time an admin tails the in-memory log ring. The route filters
  // entries to the principal's tenant + system-scope, but the read
  // itself is still privilege-sensitive (the ring carries every log
  // line including connector probes and step traces). Audit rows let
  // compliance see who tailed logs and when.  Issue #149 / W2.
  DIAGNOSTICS_LOGS_TAILED: "diagnostics.logs_tailed",
  // `/v1/diagnostics/drift` — emitted on every drift-report read.
  // The report exposes migration hashes from `drizzle.__drizzle_migrations`
  // (process-wide, not tenant-scoped) to any tenant admin, which is
  // accepted by design (the hash names a SQL file, not tenant data).
  // The audit row makes the read traceable for compliance the same
  // way `DIAGNOSTICS_LOGS_TAILED` does.
  DIAGNOSTICS_DRIFT_READ: "diagnostics.drift_read",
  // `/v1/diagnostics/version` — emitted on every read of the gated
  // version diagnostics endpoint. Mirrors `DIAGNOSTICS_DRIFT_READ`:
  // the response exposes engine version, latest available release,
  // and schema-drift posture, so compliance teams want a paper trail.
  // Issue #151 P0-1.
  DIAGNOSTICS_VERSION_READ: "diagnostics.version_read",
  // `engine --self-update` lifecycle. The binary self-mutates from a
  // host shell with no HTTP context; the audit row is the only evidence
  // a privileged change happened. Tenant: SYSTEM_TENANT_ID. Actor:
  // system_account `engine-self-update`. Issue #151 P0-2/P0-4.
  ENGINE_UPDATE_INITIATED: "engine.update.initiated",
  ENGINE_UPDATE_COMPLETED: "engine.update.completed",
  ENGINE_UPDATE_FAILED: "engine.update.failed",
  ENGINE_UPDATE_ROLLED_BACK: "engine.update.rolled_back",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export type AuditActorType = "user" | "system_account" | "system";
export type AuditResult = "success" | "denied" | "error";

// ---------------------------------------------------------------------------
// Per-action metadata schemas
// ---------------------------------------------------------------------------
//
// Audit-row `metadata` is `Record<string, unknown>` at the storage
// layer (we don't constrain the column shape per action), but the
// emitter-side schema for governance-relevant actions is pinned via
// Zod so downstream BI / SIEM consumers have a stable contract.
// Add a schema here when an action becomes load-bearing for
// compliance.

/** `conversation.forked` metadata. Emitted from
 *  `forkConversation` (service) when an operator forks a conversation
 *  at a specific message id. W1 of PR #161 review (round 5):
 *  pinning the schema so SIEM/BI consumers can reconstruct the
 *  truncation outcome and the request channel without joining back
 *  to the source conversation. The request_source field follows the
 *  AGENTS.md enum and is the same one used by ToolPolicyChangedMetadata. */
export const ConversationForkedMetadataSchema = z.object({
  /** Source conversation id; the fork's `forked_from` join key. */
  forked_from: z.string().uuid(),
  /** Message id within the source where the fork was anchored. */
  anchor_message_id: z.string().uuid(),
  /** Number of messages copied into the fork (after the cap clamp). */
  copied_message_count: z.number().int().nonnegative(),
  /** Always true today — the fork never copies tool-call rows. */
  tool_calls_omitted: z.boolean(),
  /** Always true today — the fork never copies elicitation rows. */
  elicitations_omitted: z.boolean(),
  /** True when the per-fork message cap fired and earlier history was clipped. */
  truncated: z.boolean(),
  /** Original message count in the source (pre-clamp). */
  source_message_count: z.number().int().nonnegative(),
  /** The cap in effect when the fork ran; recorded so audit-only
   *  readers can detect a future cap change without reading source. */
  copy_cap: z.number().int().positive(),
  /** AGENTS.md request_source enum: api | cli | scheduler | mcp | webhook | tool-chain | ui */
  request_source: z.enum(["api", "cli", "scheduler", "mcp", "webhook", "tool-chain", "ui"]),
});
export type ConversationForkedMetadata = z.infer<typeof ConversationForkedMetadataSchema>;

/** `tool_policy.changed` metadata. Emitted from the
 *  `PUT /v1/conversations/:id/tool-policies` handler. */
export const ToolPolicyChangedMetadataSchema = z.object({
  /** Tool whose per-conversation override changed. */
  tool: z.string().min(1),
  /** New mode, or `null` if the operator cleared the override. */
  mode: z
    .union([
      z.literal("no_confirm"),
      z.literal("confirm_before_execution"),
      z.literal("confirm_after_execution"),
    ])
    .nullable(),
  /** Prior mode for before/after diff, or `null` if no prior override existed. */
  prior_mode: z
    .union([
      z.literal("no_confirm"),
      z.literal("confirm_before_execution"),
      z.literal("confirm_after_execution"),
    ])
    .nullable(),
  /** AGENTS.md request_source enum: api | cli | scheduler | mcp | webhook | tool-chain | ui */
  request_source: z.enum(["api", "cli", "scheduler", "mcp", "webhook", "tool-chain", "ui"]),
});
export type ToolPolicyChangedMetadata = z.infer<typeof ToolPolicyChangedMetadataSchema>;

/** `diagnostics.logs_tailed` metadata. Emitted on every read of
 *  `/v1/diagnostics/logs` and `/v1/diagnostics/logs/stream`. Pinning
 *  the shape lets compliance tools query "who tailed the engine ring,
 *  with which filters, and how much did they see" without joining
 *  free-form JSON. */
export const DiagnosticsLogsTailedMetadataSchema = z.object({
  /** `json` for the paginated tail, `stream` for SSE. */
  mode: z.union([z.literal("json"), z.literal("stream")]),
  /** Number of entries returned in the JSON window; absent for SSE
   *  (the stream is unbounded). */
  returned: z.number().int().nonnegative().optional(),
  /** Lower-bound timestamp the operator polled with, if any. */
  since_ms: z.number().int().nonnegative().optional(),
  module_filter: z.string().optional(),
  action_filter: z.string().optional(),
  level_filter: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
});
export type DiagnosticsLogsTailedMetadata = z.infer<typeof DiagnosticsLogsTailedMetadataSchema>;

/** `diagnostics.drift_read` metadata. Emitted on every read of
 *  `/v1/diagnostics/drift`. */
export const DiagnosticsDriftReadMetadataSchema = z.object({
  /** Number of migrations baked into the binary. */
  embedded: z.number().int().nonnegative(),
  /** Number of rows currently in `drizzle.__drizzle_migrations`. */
  db: z.number().int().nonnegative(),
  /** Rows in the DB whose hash isn't in the embedded set. */
  unknown: z.number().int().nonnegative(),
  /** Embedded migrations whose hash isn't in the DB. */
  missing: z.number().int().nonnegative(),
});
export type DiagnosticsDriftReadMetadata = z.infer<typeof DiagnosticsDriftReadMetadataSchema>;

/** `diagnostics.version_read` metadata. Emitted on every read of
 *  `/v1/diagnostics/version`. The response holds engine version + the
 *  cached "latest from GitHub" pair, so compliance wants the same
 *  observability window as drift reads. Issue #151. */
export const DiagnosticsVersionReadMetadataSchema = z.object({
  /** Engine binary version that served the request. */
  engine_version: z.string(),
  /** Cached latest version from the boot-time update probe; absent if
   *  the probe hasn't run yet (e.g. NO_UPDATE_CHECK=1). */
  latest_version: z.string().optional(),
  /** Whether the boot-time check observed a newer release. */
  update_available: z.boolean(),
  /** Whether the embedded migration set diverges from `__drizzle_migrations`. */
  schema_drift: z.boolean(),
});
export type DiagnosticsVersionReadMetadata = z.infer<typeof DiagnosticsVersionReadMetadataSchema>;

/** `engine.update.*` metadata. Shared by initiated/completed/failed/
 *  rolled_back. The binary swap is the prototypical privileged action:
 *  there is no HTTP context, so the row is the audit story. Issue #151. */
export const EngineUpdateMetadataSchema = z.object({
  /** Version the engine was running at the start of the operation.
   *  Deliberately a bare `z.string()` (rather than a semver regex) so
   *  pre-release tags ("4.3.0-rc.1"), git-describe outputs ("4.2.0+1.gc1d"),
   *  and the rejected-rollback sentinel "<none>" all land verbatim.
   *  Forensic value comes from preserving whatever the binary actually
   *  reported, even if it doesn't match a strict shape. */
  from_version: z.string(),
  /** Target version. For INITIATED this is the planned target; for
   *  COMPLETED/ROLLED_BACK it is the version now active; for FAILED it
   *  is the version that failed to install (may equal from_version
   *  if the failure happened pre-download). Same loose-on-purpose
   *  rationale as `from_version`. */
  to_version: z.string(),
  /** Release channel the binary came from. */
  channel: z.enum(["stable", "beta"]),
  /** SHA256 of the verified binary as a 64-char lowercase hex string,
   *  or empty for INITIATED (download not yet started) / pre-download
   *  FAILED. The strict regex prevents almost-hex sentinels (e.g.
   *  "unknown", truncated) from landing in the audit row, where a
   *  forensic JOIN against `audit_log.metadata->>'sha256'` would
   *  silently miss them. */
  sha256: z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal("")]),
  /** Which CLI path triggered the row. The pair `(request_source,
   *  audit_log.actor_type)` records the dispatch path; we deliberately
   *  do NOT carry an `actor: "cli"` literal because issue #151 §6
   *  declares any HTTP / MCP self-update surface an anti-goal — the
   *  column would invite drift. DO NOT WIDEN. */
  request_source: z.enum(["self-update", "rollback"]),
  /** Reason an update failed. Set on FAILED only. */
  reason: z.string().optional(),
});
export type EngineUpdateMetadata = z.infer<typeof EngineUpdateMetadataSchema>;

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
