/**
 * Append-only. No updates. No deletes. Designed for SOC2 / ISO27001 / GDPR
 * compliance. Retention policy is handled by an external archive job — this
 * module does not delete rows.
 */

import { z } from "zod";

import { RequestSourceSchema } from "../observability/service-metadata.ts";

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
  // An admin issued a single-use provisioning invite for a user. The
  // resulting api key is minted later by the invited user at redeem
  // time — this row records the grant the admin authorized (scopes +
  // allow lists), pinned by `UserInvitedMetadataSchema`.
  USER_INVITED: "user.invited",
  // An external identity provider linked a verified
  // external subject to an existing email-matched user row by stamping
  // provider-namespaced `subject`. Records the bind so an account-takeover via a
  // provider-side email collision is auditable. Pinned by
  // `UserIdentityLinkedMetadataSchema`.
  USER_IDENTITY_LINKED: "user.identity_linked",
  USER_LOGGED_IN: "user.logged_in",
  USER_LOGGED_OUT: "user.logged_out",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_DELETED: "user.deleted",
  // The invited user redeemed their single-use invite at the
  // unauthenticated redeem endpoint, minting their OWN personal api key.
  // Paired with the `API_KEY_ISSUED` row that `issueApiKey` writes in the
  // same transaction. Pinned by `InviteRedeemedMetadataSchema`.
  INVITE_REDEEMED: "user_invite.redeemed",
  // An admin revoked an un-redeemed invite, severing the grant before the
  // invited user could mint a key from it. Pinned by
  // `UserInviteRevokedMetadataSchema`.
  INVITE_REVOKED: "user_invite.revoked",

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
  // An API key was swapped for a short-lived Bearer token (RFC 8693 token
  // exchange at /v1/oauth/token). Actor = the key's owner; metadata carries
  // the granted scope and TTL, never the key or the token.
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
  // OAuth2 reauthorization handshake initiated for a saved connector.
  // Fires from the MCP `authenticate` tool when it issues a fresh
  // PKCE state row + portal URL. The actual credential write happens
  // later at /v1/oauth/callback (CREDENTIAL_CREATED / CREDENTIAL_ROTATED);
  // this row records "the LLM asked the operator to reauth" so the
  // audit trail closes on the conversation side too.
  CONNECTOR_REAUTH_REQUESTED: "connector.reauth_requested",
  // The true→false edge of `connectors.needs_reauth`: a dead credential
  // recovered (rotated in chat, or a live authed call succeeded). Emitted by
  // `clearConnectorReauth` itself on transition so the tenant-visible state
  // change is always audited, regardless of caller — symmetric with the
  // false→true notification on `markConnectorNeedsReauth`.
  CONNECTOR_REAUTH_CLEARED: "connector.reauth_cleared",
  // Any edge of `connectors.health_state` (ok | degraded | needs_update |
  // needs_reauth) — written by connectors/health-state.ts on the transition
  // edge only, so one removed/deprecated endpoint hammered N times audits
  // exactly once. Metadata carries from/to states + the structured
  // health_error_code (endpoint_removed | endpoint_deprecated | ...).
  CONNECTOR_HEALTH_CHANGED: "connector.health_changed",
  // Any edge of `workflows.health_state` (ok | needs_attention | degraded) —
  // the workflow-level rollup of a dependency's health change or a failed
  // preflight/contract probe.
  WORKFLOW_HEALTH_CHANGED: "workflow.health_changed",

  WORKFLOW_CREATED: "workflow.created",
  WORKFLOW_UPDATED: "workflow.updated",
  WORKFLOW_DELETED: "workflow.deleted",
  WORKFLOW_VERSION_RESTORED: "workflow.version_restored",
  WORKFLOW_AUTHORITY_GRANTED: "workflow.authority_granted",
  WORKFLOW_AUTHORITY_REVOKED: "workflow.authority_revoked",
  // Committed via save_workflow_draft with `force=true` — no successful preview
  // was recorded. Metadata captures the classification of the most recent
  // preview attempt (if any) so operators can audit why the override was
  // taken.
  WORKFLOW_COMMITTED_OVERRIDE: "workflow.committed_override",
  // Defence-in-depth (Root A safety net): a workflow whose
  // name+description carries cadence phrasing ("every day at 7pm",
  // "täglich um 18 Uhr") was committed with `trigger.kind = "request"`
  // — i.e. the LLM forgot to bind a schedule. The row records the
  // matched phrases in metadata so operators can audit whether the
  // miss was reasonable (e.g. "send every error to email" — not
  // cadence) or a regression.
  WORKFLOW_SCHEDULE_NOT_BOUND: "workflow.schedule_not_bound",

  EXECUTION_STARTED: "execution.started",
  APPROVAL_DISPATCH_RESERVED: "approval.dispatch_reserved",
  APPROVAL_EXECUTION_BOUND: "approval.execution_bound",
  APPROVAL_DISPATCH_DENIED: "approval.dispatch_denied",
  EXECUTION_ABORT_REQUESTED: "execution.abort_requested",
  EXECUTION_COMPLETED: "execution.completed",
  EXECUTION_ABORTED: "execution.aborted",
  EXECUTION_AUTO_RETRIED: "execution.auto_retried",
  // A boot or periodic recovery sweep repaired execution state after a worker
  // disappeared: either a stale running execution was terminalized or running
  // step rows were reconciled from their already-terminal parent.
  EXECUTION_CRASH_RECOVERED: "execution.crash_recovered",

  // Persistent workflow run state: cross-run watermark / cursor
  // reads + writes, tenant-encrypted, scoped to a single workflow.
  // Emitted from the step-runner when a request step declares
  // `state_read` / `state_write`. Both pair with `metadata.key`.
  STATE_READ: "state.read",
  STATE_WRITE: "state.write",

  // Step-level wait checkpoint. First step-level audit pair
  // in subkit — wait_started fires at step start with the configured
  // sleep_until_ts; wait_completed pairs at step end with `reason`
  // (`timer` for normal completion, `cancelled` for abort, or `recovered`
  // for engine-boot reaper resumes). Both pair with `metadata.step_id`.
  WAIT_STARTED: "wait.started",
  WAIT_COMPLETED: "wait.completed",
  /** A wait checkpoint outlived the process that armed it. The wait did not
   *  complete and the execution does not continue — see wait-reaper.ts. */
  WAIT_ABANDONED: "wait.abandoned",

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

  // Proactive self-healing drift scan lifecycle (admin HTTP, scheduler tick, MCP).
  //  - TRIGGERED is emitted before the scan runs, with metadata.source =
  //    "admin_http" | "scheduler" | "mcp" and the filters payload.
  //  - COMPLETED is emitted after the scan finishes (or fails) with the
  //    counter metadata so operators can chart drift surface area without
  //    joining back to `self_healing_scans`. PATCH_CANDIDATE_PROPOSED still
  //    fires per candidate created inside the scan.
  SELF_HEALING_SCAN_TRIGGERED: "self_healing.scan.triggered",
  SELF_HEALING_SCAN_COMPLETED: "self_healing.scan.completed",

  // A critical predictive-maintenance risk signal crossed its threshold
  // when the operator health digest was built (pool exhaustion, DLQ
  // growth, RSS approaching the host memory cap, …). Resource_id is the
  // signal `kind`; metadata carries metric / value / threshold so the SIEM
  // trail proves the operator was warned before the incident landed.
  RISK_SIGNAL_RAISED: "operator.risk_signal_raised",

  // The matching recovery edge — a previously-critical risk signal fell back
  // below its threshold. Paired with RISK_SIGNAL_RAISED so the SIEM can
  // compute the incident window (MTTR) from the two edges.
  RISK_SIGNAL_CLEARED: "operator.risk_signal_cleared",

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
  /** Boot hydration skipped a chat_workspaces row (e.g. signing
   *  secret unset). Distinct from `chat_workspace.installed` denied so
   *  SIEM dashboards counting "install attempts in tenant X" don't
   *  false-positive on every restart. */
  CHAT_WORKSPACE_HYDRATE_SKIPPED: "chat_workspace.hydrate_skipped",
  CHAT_IDENTITY_LINKED: "chat_identity.linked",
  CHAT_IDENTITY_UNLINKED: "chat_identity.unlinked",
  CHAT_MESSAGE_RECEIVED: "chat.message.received",
  CHAT_MESSAGE_DENIED: "chat.message.denied",
  CHAT_MESSAGE_SENT: "chat.message.sent",
  /** chat_events_seen retention sweep — keeps the replay-dedup table
   *  bounded. Emitted once per successful sweep with `deleted` and
   *  `duration_ms` in metadata. Dotted segments match the
   *  `chat.message.*` convention. */
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

  DATA_EXPORTED: "data.exported",
  DATA_IMPORTED: "data.imported",

  CONVERSATION_CREATED: "conversation.created",
  // Distinct action so audit-log queries can separate forks (which
  // clone prior tenant content) from greenfield creates. Metadata
  // still carries forked_from / anchor_message_id /
  // copied_message_count.
  CONVERSATION_FORKED: "conversation.forked",
  CONVERSATION_COMPLETED: "conversation.completed",
  CONVERSATION_CANCELLED: "conversation.cancelled",
  CONVERSATION_COMMITTED: "conversation.committed",
  CONVERSATION_COMPACTED: "conversation.compacted",
  CONVERSATION_UPDATED: "conversation.updated",
  CONVERSATION_MEMORY_INJECTED: "conversation.memory_injected",
  CONVERSATION_RESUMED: "conversation.resumed",
  // A person took a conversation out of their own list, or put it back. Per
  // user and reversible; the row and its history stay.
  CONVERSATION_HIDDEN: "conversation.hidden",
  CONVERSATION_UNHIDDEN: "conversation.unhidden",
  // An explicit `load_skill` tool call mutated the conversation's persisted
  // `loaded_skills` palette (tenant-visible state that survives session
  // resumption). Metadata carries skill_slug / skill_id / already_loaded so
  // operators can trace which skills a conversation pulled into context.
  // Per-turn recency demotions are derived/automatic and are NOT audited.
  CONVERSATION_SKILL_LOADED: "conversation.skill_loaded",
  // Prove-after: an answer's grounding sources, mirrored from the turn's
  // grounding-tool results so "this answer ← these sources" is auditable.
  CONVERSATION_ANSWER_CITED: "conversation.answer_cited",
  // A backgrounded conversation turn (MCP async Tasks, SEP-1686) threw
  // inside the `conversation.run-turn` pg-boss worker. Metadata carries
  // the `mcp_task_id` + the `failure_reason` code so operators can
  // trace a failed task back to the run that produced it. A turn that
  // is *cancelled* (client `tasks/cancel`) does NOT emit this — it is
  // an expected terminal state, not a failure.
  CONVERSATION_TURN_FAILED: "conversation.turn_failed",
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

  // Unified files resource. `FILE_DELETED` is emitted whenever the
  // engine removes a `files` row (hard delete) — covering the cleanup
  // cron's pending-orphan sweep (`reason: 'pending_expired'`) and the
  // unlinked-TTL hard-delete (`reason: 'unlinked_ttl'`) — as well as
  // any future explicit DELETE surface. The legacy
  // `CONVERSATION_ATTACHMENT_*` actions were consolidated into the
  // canonical `FILE_*` vocabulary; new file deletions land here.
  FILE_DELETED: "file.deleted",
  // `FILE_CREATED` — inline-upload sink (`POST /v1/files/inline`)
  // persisted a new `files` row. Metadata carries `filename`,
  // `content_type`, and `size_bytes_bucket` (never raw `size_bytes` —
  // cardinality). Filename is permitted here only; downstream events
  // (download, finalize, link) elide it to keep audit volume low.
  FILE_CREATED: "file.created",
  // `FILE_BATCH_CREATED` — one row per batch-create request (not per
  // entry). Metadata records the batch shape (`count`, `dedup_hits`)
  // so operators can chart streamed-upload throughput without joining back to
  // the per-file `FILE_CREATED` rows that fire on finalize.
  FILE_BATCH_CREATED: "file.batch_created",
  // `FILE_FINALIZED` — authenticated streamed-upload path completed
  // (`POST /v1/files/:id/finalize`). Metadata records the
  // post-finalize status (`ready` / `failed`) and the verified
  // sha256-match outcome. Paired with `FILE_SCAN_COMPLETED` when the
  // synchronous scanner ran.
  FILE_FINALIZED: "file.finalized",
  // `FILE_UPLOAD_RECEIVED` — emitted from the authenticated engine sink
  // (`PUT /v1/files/{id}/upload`) after `putStream` writes bytes but
  // before the client calls finalize. Closes the audit gap where a
  // client uploads and then abandons the session — without this row
  // the audit ledger only sees the bytes when the cleanup cron
  // eventually reaps the pending row (≥1h later). Tagged with
  // `source: "authenticated_engine_upload"` so SIEM can distinguish it
  // from any future S3-side notification path.
  FILE_UPLOAD_RECEIVED: "file.upload_received",
  // `FILE_DOWNLOADED` — `GET /v1/files/:id/content` served bytes to a
  // caller. Metadata carries `size_bytes_bucket` and `range` (true /
  // false) so compliance can chart exfil patterns without per-byte
  // cardinality.
  FILE_DOWNLOADED: "file.downloaded",
  // `FILE_LINK_ADDED` — a polymorphic `file_links` row was attached
  // pointing the file at an owning resource. Metadata carries
  // `resource_type` + `resource_id`; the `file_id` is the audit row's
  // primary resource.
  FILE_LINK_ADDED: "file.link_added",
  // `FILE_LINK_REMOVED` — a `file_links` row was deleted. Emitted
  // whenever a caller unlinks a file from an owning resource (today:
  // `DELETE /v1/conversations/:id/attachments/:slug`). The file row
  // itself stays in place — the cleanup cron GCs orphans after the
  // unlinked-TTL grace. Symmetric to `FILE_LINK_ADDED`, same metadata
  // shape, so audit-readers can chart attach/detach pairs by joining on
  // `(file_id, resource_id)`.
  FILE_LINK_REMOVED: "file.link_removed",
  // `FILE_SCAN_COMPLETED` — the scanner (clamd / Noop) returned a
  // verdict for an upload. Metadata: `verdict` (clean / infected),
  // `engine` (scanner identifier), optional `signature`. Audited
  // separately from `FILE_CREATED` / `FILE_FINALIZED` because a future
  // async-scan path will decouple the two.
  FILE_SCAN_COMPLETED: "file.scan_completed",

  SK_CLI_LOGIN: "sk_cli.login",
  SK_CLI_LOGOUT: "sk_cli.logout",
  SK_CLI_TENANT_SWITCHED: "sk_cli.tenant_switched",
  // A caller marked a window of `cli_notification_inbox` rows read, up to
  // a cursor. Emitted from `POST /v1/notifications/inbox/ack`. The read
  // mark is a state change, so AGENTS.md requires the audit row; metadata
  // carries `up_to_cursor` and `marked` (the rows that were still unread
  // for this caller) so operators can reconstruct the watermark. The rows
  // themselves survive — only the retention sweep deletes them.
  SK_CLI_INBOX_ACKED: "sk_cli.inbox_acked",
  /** Retention sweep pruned `cli_notification_inbox` rows past the
   *  configured window; read marks cascade with them. Emitted once per
   *  successful sweep under SYSTEM_TENANT_ID with `deleted` and
   *  `duration_ms` in metadata. */
  NOTIFICATION_INBOX_PRUNED: "notification.inbox_pruned",

  APPROVAL_REQUESTED: "approval.requested",
  // A HUMAN granted (or refused to grant) the approval, out of band, through
  // the approval portal — or in band, on a surface that actually reached them.
  // `actor_id` is that human. Distinct from APPROVAL_APPROVED, which the
  // engine writes later, once the granted approval survives RBAC + policy and
  // is about to execute. Distinct from APPROVAL_REJECTED, which records a
  // CLAIM the engine refused, not a decision a human made.
  APPROVAL_GRANTED: "approval.granted",
  APPROVAL_DECLINED: "approval.declined",
  APPROVAL_APPROVED: "approval.approved",
  APPROVAL_REJECTED: "approval.rejected",
  // Emitted once per scheduler tick after the `tool_approvals` retention
  // sweeps. Bounds how long the encrypted approved-args ciphertext lives.
  APPROVAL_EXPIRED_PRUNED: "approval.expired_pruned",
  // A human GRANTED an approval and the engine never claimed it before the
  // window closed — the person said yes and nothing ran. Its own action because
  // every other trace of this outcome is indistinguishable from "nobody
  // answered": the claim miss reports `confirmation_expired` whether or not a
  // grant ever landed, and it does not burn the handle, so it writes no audit
  // row at all. Production lost five approvals this way, silently, before there
  // was anything to query. A non-zero count here is always a bug.
  APPROVAL_GRANT_ABANDONED: "approval.grant_abandoned",
  // A `protocol_native` (MCP-bridge) elicitation row degraded mid-call
  // to the portal DB-pause path because the MCP `elicitation`
  // capability raced away. The row flips `protocol_native: true →
  // false` — a governance-row state change. This row preserves the
  // forensic trace that the carrier was minted as `mcp_elicitation`
  // before becoming `portal`.
  ELICITATION_DEMOTED_TO_PORTAL: "elicitation.demoted_to_portal",
  // A pending elicitation whose approval handle expired unanswered was
  // resolved to `timeout` by the elicitation-expiry sweep and its
  // conversation reactivated. Neither an approval nor a rejection — a
  // distinct action keeps SIEM queries honest (no human decided).
  ELICITATION_EXPIRED: "elicitation.expired",

  // Knowledge Sources
  KNOWLEDGE_SOURCE_CREATED: "knowledge_source.created",
  KNOWLEDGE_SOURCE_UPDATED: "knowledge_source.updated",
  KNOWLEDGE_SOURCE_DELETED: "knowledge_source.deleted",
  KNOWLEDGE_SOURCE_INGESTED: "knowledge_source.ingested",
  KNOWLEDGE_SOURCE_REFRESHED: "knowledge_source.refreshed",
  KNOWLEDGE_SOURCE_ANALYZED: "knowledge_source.analyzed",
  // Synthesised connector endpoint candidates from a file (README,
  // architecture doc, code dump). Distinct from the regular
  // KNOWLEDGE_SOURCE_REFRESHED action — discovery from files is a
  // different reason code (`file_analysis`) and an LLM call sat behind
  // the row, so operators want to filter it separately.
  KNOWLEDGE_SOURCE_CANDIDATES_SYNTHESIZED: "knowledge_source.candidates_synthesized",

  // Discovery
  DISCOVERY_RUN_CREATED: "discovery.run_created",
  DISCOVERY_RUN_COMPLETED: "discovery.run_completed",
  DISCOVERY_RUN_FAILED: "discovery.run_failed",
  DISCOVERY_ARTIFACT_PROPOSED: "discovery.artifact_proposed",
  DISCOVERY_ARTIFACT_APPROVED: "discovery.artifact_approved",
  DISCOVERY_ARTIFACT_REJECTED: "discovery.artifact_rejected",

  // Self-Improving Skills
  SKILL_CANDIDATE_PROPOSED: "skill_candidate.proposed",
  SKILL_CANDIDATE_UPDATED: "skill_candidate.updated",
  SKILL_CANDIDATE_APPROVED: "skill_candidate.approved",
  SKILL_CANDIDATE_REJECTED: "skill_candidate.rejected",
  SKILL_CANDIDATE_SUPERSEDED: "skill_candidate.superseded",

  // Coding-agent session capture (transcripts → learning candidates)
  AGENT_SESSION_CAPTURED: "agent_session.captured",

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

  // Hardened audit surface for the conversation pipeline.
  //
  // - `connector.draft.credential_rejected` — the LLM tried to splice a
  //   credential into the connector draft via `update_connector_draft`.
  //   Previously this emitted only a `log.connector.draft.credential_rejected`
  //   structured log; the audit row makes the rejection visible to
  //   compliance tooling that scans `audit_log`.
  // - `tool_policy.confirmation_required` — the per-turn policy
  //   resolver decided a tool call must pause for human confirmation
  //   (env=prod, dangerous tool, inline credential present, etc.).
  //   Operators query this kind to audit policy decisions across
  //   tenants without scraping debug logs.
  CONNECTOR_DRAFT_CREDENTIAL_REJECTED: "connector.draft.credential_rejected",
  TOOL_POLICY_CONFIRMATION_REQUIRED: "tool_policy.confirmation_required",
  // - `tool_policy.confirm_collapsed_mcp` — the resolver decided
  //   confirm_before_execution, but the turn was submitted over MCP and
  //   the tool is in the enumerated collapsible-write set, so the
  //   CLIENT's destructiveHint dialog on the outer conversation_* call
  //   was the human gate and no server pause was minted. Records that
  //   the gate was the client dialog, not a server approval.
  TOOL_POLICY_CONFIRM_COLLAPSED_MCP: "tool_policy.confirm_collapsed_mcp",
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
  SETTINGS_REVISION_SAVED: "settings.revision_saved",
  SETTINGS_REVISION_ACTIVATED: "settings.revision_activated",
  SETTINGS_REVISION_RESTART_REQUIRED: "settings.revision_restart_required",
  SETTINGS_REVISION_ACTIVATION_FAILED: "settings.revision_activation_failed",
  SECRET_VERSION_CREATED: "secret.version_created",
  SECRET_VERSION_REVOKED: "secret.version_revoked",
  // "Freigaben statt Eingaben": a version written by `engine --vault-set
  // --pending` (or by anything else holding a value a person has not seen)
  // waits in the Cockpit. Approving makes it current and re-pins the
  // bindings it was prepared for; rejecting revokes it. The value itself
  // appears in none of the three rows.
  SECRET_VERSION_PREPARED: "secret.version_prepared",
  SECRET_VERSION_APPROVED: "secret.version_approved",
  SECRET_VERSION_REJECTED: "secret.version_rejected",

  // ── Outbound connections (SubKit as OAuth 2.1 client, Cockpit "Anbindungen") ──
  // Tokens live as runtime secret versions and never appear in metadata;
  // the rows carry the connection name, the issuer host and the scopes.
  CONNECTION_CREATED: "connection.created",
  CONNECTION_RENEWED: "connection.renewed",
  CONNECTION_FAILED: "connection.failed",
  CONNECTION_REFRESHED: "connection.refreshed",
  CONNECTION_REFRESH_FAILED: "connection.refresh_failed",
  CONNECTION_DISCONNECTED: "connection.disconnected",
  // `engine --rewrap-master-key --from-file <previous>` re-encrypted every
  // runtime secret version under the running MASTER_KEY. Written once per
  // sweep, by a host-side operator with no session — actor_type `system`,
  // actor_id null. The metadata carries the counts and the fingerprints of
  // both keys, never key material.
  MASTER_KEY_REWRAPPED: "secret.master_key_rewrapped",
  STATELESS_BRIDGE_CONFIG_IMPORTED: "stateless_bridge.config_imported",
  STATELESS_BRIDGE_OBJECT_MIGRATED: "stateless_bridge.object_migrated",
  STATELESS_BRIDGE_COMPLETED: "stateless_bridge.completed",

  // Trigger lifecycle for workflow-bound webhooks + schedules. The
  // `bound` / `unbound` events fire from the workflow save/delete
  // path (see `apps/engine/src/workflows/service.ts`) and reflect the
  // reverse binding into `webhooks_inbound` / `workflows_schedules`.
  // The `fired` / `failed_verification` events are emitted by the
  // executor side (webhook firing and schedule firing) — the
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
  // compliance see who tailed logs and when.
  DIAGNOSTICS_LOGS_TAILED: "diagnostics.logs_tailed",
  // `/v1/diagnostics/drift` — emitted on every drift-report read.
  // The report exposes migration hashes from `subkit.__drizzle_migrations`
  // (process-wide, not tenant-scoped) to any tenant admin, which is
  // accepted by design (the hash names a SQL file, not tenant data).
  // The audit row makes the read traceable for compliance the same
  // way `DIAGNOSTICS_LOGS_TAILED` does.
  DIAGNOSTICS_DRIFT_READ: "diagnostics.drift_read",
  // `/v1/diagnostics/version` — emitted on every read of the gated
  // version diagnostics endpoint. Mirrors `DIAGNOSTICS_DRIFT_READ`:
  // the response exposes engine version, latest available release,
  // and schema-drift posture, so compliance teams want a paper trail.
  DIAGNOSTICS_VERSION_READ: "diagnostics.version_read",
  // `/v1/diagnostics/integrations` — emitted on every read of the
  // connector/workflow health rollup. Mirrors DIAGNOSTICS_VERSION_READ:
  // the response exposes which integrations are broken/deprecated, so
  // compliance wants the same observability window.
  DIAGNOSTICS_INTEGRATIONS_READ: "diagnostics.integrations_read",
  // `engine --self-update` lifecycle. The binary self-mutates from a
  // host shell with no HTTP context; the audit row is the only evidence
  // a privileged change happened. Tenant: SYSTEM_TENANT_ID. Actor:
  // system_account `engine-self-update`.
  ENGINE_UPDATE_INITIATED: "engine.update.initiated",
  ENGINE_UPDATE_COMPLETED: "engine.update.completed",
  ENGINE_UPDATE_FAILED: "engine.update.failed",
  ENGINE_UPDATE_ROLLED_BACK: "engine.update.rolled_back",

  // ---------------------------------------------------------------------
  // External MCP servers. An external MCP server is a connector whose
  // driver is `mcp`, so its lifecycle (created / updated / deleted /
  // health_changed) lands on the `connector.*` actions above and is NOT
  // duplicated here. What remains are the four events that only an MCP
  // session produces, plus the two invocation rows.
  // ---------------------------------------------------------------------
  // A handshake against the remote succeeded. Metadata carries the tool
  // count and the manifest hash — non-secret integrity/sizing signals.
  CONNECTOR_MCP_HANDSHAKE_OK: "connector.mcp_handshake_ok",
  // The remote reshaped its tool manifest between two handshakes. This is
  // its OWN action rather than a `connector.updated` row carrying a
  // `changed_fields: ["tools_manifest_hash"]` convention: the hash lives
  // on `connector_mcp_sessions`, which no operator surface can write, so
  // "this row exists" already means "the remote changed", structurally.
  CONNECTOR_MCP_MANIFEST_DRIFT: "connector.mcp_manifest_drift",
  // An OAuth client was registered with the remote's IdP (RFC 7591
  // dynamic registration) and its non-secret client_id mirrored onto the
  // connector's config. The client_secret never appears here.
  CONNECTOR_MCP_CLIENT_REGISTERED: "connector.mcp_client_registered",
  // A tool exposed by a registered external MCP server was invoked from
  // the conversation loop. Distinct resource_type ("mcp_external_tool")
  // so invocation volume can be aggregated apart from the connector
  // configuration rows.
  MCP_EXTERNAL_TOOL_INVOKED: "mcp_external_tool.invoked",
  // Assembling the external-MCP tool palette for a conversation turn
  // failed (a DB error enumerating connectable servers, or a pool fault).
  // The turn degrades to zero external tools rather than aborting; this
  // row is the queryable signal that the degradation happened, so an
  // operator isn't left with only a transient log line.
  MCP_EXTERNAL_TOOL_PALETTE_ASSEMBLY_FAILED: "mcp_external_tool.palette_assembly_failed",
  // Interactive browser OAuth 2.1 onboarding for an OAuth-only external
  // MCP server. `authorization_started` is emitted when a pending
  // `mcp_oauth_states` flow row is created; `authorized` on a successful
  // callback + token write; `authorization_failed` when the callback is
  // rejected (bad state, issuer mismatch, exchange error). Metadata
  // carries `issuer_host` (HOST ONLY — never the token or full
  // authorization URL), secret-by-reference like every connector row.
  CONNECTOR_MCP_AUTHORIZATION_STARTED: "connector.mcp_authorization_started",
  CONNECTOR_MCP_AUTHORIZED: "connector.mcp_authorized",
  CONNECTOR_MCP_AUTHORIZATION_FAILED: "connector.mcp_authorization_failed",

  // ---------------------------------------------------------------------
  // External non-LLM provider calls reserved for future opt-in,
  // connector-shaped writers that land under a per-tenant budget — not
  // for engine-baseline integrations (the runtime-independence policy
  // forbids API-key dependencies on the discovery / ranking / scraping
  // hot paths). The metering ledger
  // (apps/engine/src/db/schema/external_call_metering.ts) deliberately
  // does NOT carry an `audit_id` pointer (parity with `llm_usage`); the
  // *originating* state change still needs an audit row, and consumers
  // join via `(tenant_id, created_at)`.
  // ---------------------------------------------------------------------
  EXTERNAL_PROVIDER_CALL_SUCCEEDED: "external_provider.call_succeeded",
  EXTERNAL_PROVIDER_CALL_FAILED: "external_provider.call_failed",

  OAUTH_CLIENT_REGISTERED: "oauth_client.registered",
  OAUTH_CLIENT_REGISTRATION_FAILED: "oauth_client.registration_failed",
  // `/v1/oauth/callback` failure paths — the provider denied access,
  // the callback carried no authorization code, or the token exchange
  // raised. Each deletes the claimed `connector_oauth_states` row (a
  // state change), so AGENTS.md requires an audit row. The companion
  // `connector.oauth.callback_failed` pubsub event is observability,
  // not the durable compliance record — this is. The state-not-found
  // branch emits nothing: there is no claimed row and so no tenant to
  // scope the audit entry to.
  CONNECTOR_OAUTH_CALLBACK_FAILED: "connector.oauth.callback_failed",
  // Single-use browser-openable grant issued by mintOAuthStartGrantUrl.
  // Audited at mint time with the connector_id as resource. The grant
  // is stored as a sha256 hash only; the plaintext is never logged.
  CONNECTOR_OAUTH_GRANT_ISSUED: "connector.oauth.grant_issued",
  // Grant consumed (atomically claimed) by the unauthenticated GET
  // /v1/connectors/{id}/oauth/start?grant=… route. Written BEFORE
  // beginConnectorOAuthDance runs; a failure after this row means the
  // grant is burned but the dance did not start (HTML error page shown).
  CONNECTOR_OAUTH_GRANT_CONSUMED: "connector.oauth.grant_consumed",
  // Single-use browser-openable credential-setup grant issued by
  // mintCredentialSetupGrantUrl for non-OAuth (bearer/basic/header/query)
  // connectors. Audited at mint time with the connector_id as resource.
  // The grant is stored as a sha256 hash only; the plaintext is never
  // logged.
  CONNECTOR_CREDENTIAL_GRANT_ISSUED: "connector.credential_grant.issued",
  // Grant consumed (atomically claimed) by the unauthenticated POST
  // /v1/connectors/{id}/credentials/setup route. Written BEFORE the
  // credential is written — a failure after this row means the grant is
  // burned but the credential write did not complete.
  CONNECTOR_CREDENTIAL_GRANT_CONSUMED: "connector.credential_grant.consumed",

  // ── MCP OAuth 2.1 authorization server ────────────────────────────────────
  MCP_OAUTH_CLIENT_REGISTERED: "mcp_oauth.client_registered",
  MCP_OAUTH_CODE_ISSUED: "mcp_oauth.code_issued",
  MCP_OAUTH_TOKEN_ISSUED: "mcp_oauth.token_issued",
  MCP_OAUTH_TOKEN_REFRESHED: "mcp_oauth.token_refreshed",
  MCP_OAUTH_TOKEN_REVOKED: "mcp_oauth.token_revoked",
  MCP_OAUTH_CONSENT_GRANTED: "mcp_oauth.consent_granted",
  MCP_OAUTH_CONSENT_DENIED: "mcp_oauth.consent_denied",
  MCP_OAUTH_TOKEN_USED: "mcp_oauth.token_used",
  MCP_OAUTH_DCR_RATE_LIMITED: "mcp_oauth.dcr_rate_limited",
  // Emitted once per scheduler tick after the four retention sweeps.
  MCP_OAUTH_EXPIRED_PRUNED: "mcp_oauth.expired_pruned",
  // Emitted when an admin disables a registered OAuth client via the admin API.
  MCP_OAUTH_CLIENT_DISABLED: "mcp_oauth.client_disabled",
  MCP_OAUTH_CLIENT_LISTED: "mcp_oauth.client_listed",
  MCP_OAUTH_TOKEN_REJECTED: "mcp_oauth.token_rejected",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

/** Set of every `file.*` audit action — declarative so downstream
 *  filters (SIEM exporters, MCP capability surfaces, the
 *  `files-actions.test.ts` set-equality assertion) can match without
 *  re-deriving the prefix grammar inline. Extend this whenever a new
 *  `FILE_*` action lands; the cardinality test will fail if the action
 *  is declared on `AuditAction` but not here. */
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
]);

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
 *  at a specific message id. The schema is pinned so SIEM/BI consumers
 *  can reconstruct the truncation outcome and the request channel
 *  without joining back to the source conversation. The request_source
 *  field follows the AGENTS.md enum and is the same one used by
 *  ToolPolicyChangedMetadata. */
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
  /** Canonical request_source — see `RequestSourceSchema` for the full list. */
  request_source: RequestSourceSchema,
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
  /** Canonical request_source — see `RequestSourceSchema` for the full list. */
  request_source: RequestSourceSchema,
});
export type ToolPolicyChangedMetadata = z.infer<typeof ToolPolicyChangedMetadataSchema>;

/** `policy.denied` metadata — TOOL-DISPATCHER emitter only. `policy.denied`
 *  has several emitters (HTTP middleware, workflows/rbac, fast-path reads)
 *  with their own shapes; this schema pins the shared tool dispatcher's
 *  RBAC gate (`emitPolicyDenied`), the one that correlates with the
 *  approval lifecycle: `args_hash` is the SAME fingerprint
 *  `APPROVAL_REQUESTED` and `tool_approvals` carry (sha256 over
 *  confirm-marker-stripped, stably-stringified args — a hash only, never
 *  raw values), so "was this exact intent denied before?" is a metadata
 *  join. First-call denials hash raw invocation args (RBAC deliberately
 *  runs before canonicalization); confirmed replays hash the canonical
 *  `claim.args` and therefore match their approval row's hash. */
export const ToolDispatchPolicyDeniedMetadataSchema = z.object({
  /** Tool name as invoked. */
  tool: z.string().min(1),
  /** Canonical tool name (alias-resolved). */
  canonical_tool: z.string().min(1),
  /** Dispatch surface the denial happened on. */
  via: z.string().min(1),
  /** Canonical request_source — see `RequestSourceSchema` for the full list. */
  request_source: RequestSourceSchema,
  /** RBAC permission that was required and denied. */
  permission: z.string().min(1),
  /** sha256 fingerprint of the denied call's args (see docblock). */
  args_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Present when the denial burned a claimed approval (confirmed replay). */
  approval_id: z.string().uuid().optional(),
  /** RBAC resource, when the tool resolved one (replay denials only —
   *  on first-call denials the resource is the audit row's own
   *  resource_type/resource_id). */
  rbac_resource_type: z.string().min(1).optional(),
  rbac_resource_id: z.string().min(1).optional(),
});
export type ToolDispatchPolicyDeniedMetadata = z.infer<
  typeof ToolDispatchPolicyDeniedMetadataSchema
>;

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
  /** Number of rows currently in `subkit.__drizzle_migrations`. */
  db: z.number().int().nonnegative(),
  /** Tagged rows whose identity does not match the embedded set. */
  unknown: z.number().int().nonnegative(),
  /** Accepted tagless rows retained from the pre-squash journal. */
  historical: z.number().int().nonnegative(),
  /** Embedded migration identities absent from the DB. */
  missing: z.number().int().nonnegative(),
});
export type DiagnosticsDriftReadMetadata = z.infer<typeof DiagnosticsDriftReadMetadataSchema>;

/** `diagnostics.version_read` metadata. Emitted on every read of
 *  `/v1/diagnostics/version`. The response holds engine version + the
 *  cached "latest from GitHub" pair, so compliance wants the same
 *  observability window as drift reads. */
export const DiagnosticsVersionReadMetadataSchema = z.object({
  /** Engine binary version that served the request. */
  engine_version: z.string(),
  /** Cached latest version from the boot-time update probe; absent if
   *  the probe hasn't run yet (for example update checking is disabled). */
  latest_version: z.string().optional(),
  /** Whether the boot-time check observed a newer release. */
  update_available: z.boolean(),
  /** Whether tagged or missing journal identities disagree with the embedded set. */
  schema_drift: z.boolean(),
});
export type DiagnosticsVersionReadMetadata = z.infer<typeof DiagnosticsVersionReadMetadataSchema>;

/** `/v1/diagnostics/integrations` — connector/workflow health rollup read.
 *  Counts only (no slugs) so the audit row stays small while still
 *  evidencing WHAT posture the caller saw. */
export const DiagnosticsIntegrationsReadMetadataSchema = z.object({
  connectors_total: z.number().int().nonnegative(),
  connectors_attention: z.number().int().nonnegative(),
  workflows_attention: z.number().int().nonnegative(),
});
export type DiagnosticsIntegrationsReadMetadata = z.infer<
  typeof DiagnosticsIntegrationsReadMetadataSchema
>;

// ---------------------------------------------------------------------------
// `FILE_*` metadata schemas — pinned so SIEM/BI consumers have a stable
// contract per action. Filename is allowed only on `FILE_CREATED`
// (cardinality call: download is high-frequency, finalize / link can be
// joined back to the create row via `file_id`). `size_bytes_bucket` uses
// the same coarse enum as the existing `bucketSize` helper.

/** Coarse size buckets emitted by `bucketSize` — pinned here so the
 *  per-action schemas can reuse the same enum without importing the
 *  helper (which lives in `audit/buckets.ts` and would cause a cycle if
 *  we imported it into `audit/types.ts`). The values must stay in sync
 *  with `audit/buckets.ts:SizeBucket`. */
const SizeBucketSchema = z.enum(["<1KB", "<1MB", "<10MB", "<100MB", ">=100MB"]);

// `RequestSourceSchema` is re-imported from
// `observability/service-metadata.ts` (top of file) so the audit
// metadata schemas and the per-request Hono context variable share
// exactly one source of truth. Optional on every schema below
// because the cron sweeps and self-update path emit with a synthetic
// actor that has no HTTP context (those emitters pass `"scheduler"`
// explicitly when relevant).

/** `file.created` metadata. Filename + content_type are the user-supplied
 *  shape captured at upload; sha256_prefix is the first 16 hex chars of
 *  the asserted sha256 (truncated so a SIEM-side index is small but a
 *  forensic JOIN against an external sha256 is still tractable). The
 *  `dedup` flag distinguishes inline dedup hits (an existing row was
 *  reused, no new bytes written) from cold creates. */
export const FileCreatedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  size_bytes_bucket: SizeBucketSchema,
  content_type: z.string().nullable(),
  // Capped at 255 to mirror `InlineUploadSchema.filename` and
  // `BatchCreateEntrySchema.filename` (api/files-schemas.ts). Without
  // this cap a future emitter passing an unbounded filename would
  // inflate `audit_log.metadata` row size + index width.
  filename: z.string().max(255),
  sha256_prefix: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  dedup: z.boolean().optional(),
  request_source: RequestSourceSchema.optional(),
  /** Free-form route-level discriminator distinguishing equivalent
   *  emissions from different entry points (e.g.
   *  `conversation_attachments` for the portal-wrapper route vs. the
   *  canonical `/v1/files/inline` route). Lets SIEM queries split
   *  audit rows by emission path without joining back to the request
   *  log. Mirrors `FileLinkAddedMetadataSchema.source`. */
  source: z.string().optional(),
});
export type FileCreatedMetadata = z.infer<typeof FileCreatedMetadataSchema>;

/** `file.link_added` metadata. */
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

/** `file.link_removed` metadata. Same shape as `FileLinkAddedMetadata`. */
export const FileLinkRemovedMetadataSchema = FileLinkAddedMetadataSchema;
export type FileLinkRemovedMetadata = z.infer<typeof FileLinkRemovedMetadataSchema>;

/** `file.finalized` metadata. `status` is the post-finalize row status
 *  (ready / failed / denied). `outcome` describes the verifier branch
 *  taken (e.g. `sha256_mismatch`, `size_cap`); `dedup` is set on the
 *  sibling-collapse path. */
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

/** `file.downloaded` metadata. Deliberately no filename — download is
 *  high-frequency and the audit volume would inflate. `range` is true
 *  when the request carried an HTTP Range header. `content_type` is
 *  preserved (it's already a low-cardinality column on the file row). */
export const FileDownloadedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  size_bytes_bucket: SizeBucketSchema,
  range: z.boolean().optional(),
  content_type: z.string().nullable().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type FileDownloadedMetadata = z.infer<typeof FileDownloadedMetadataSchema>;

/** `file.deleted` metadata. `reason` is a free-form short string —
 *  current emitters use `user_request`, `pending_expired`,
 *  `unlinked_ttl`. */
export const FileDeletedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  reason: z.string(),
  request_source: RequestSourceSchema.optional(),
});
export type FileDeletedMetadata = z.infer<typeof FileDeletedMetadataSchema>;

/** `file.scan_completed` metadata. Optional `signature` carries the
 *  scanner's match identifier when the verdict is `infected`. */
export const FileScanCompletedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  verdict: z.string(),
  engine: z.string(),
  signature: z.string().nullable().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type FileScanCompletedMetadata = z.infer<typeof FileScanCompletedMetadataSchema>;

/** `file.batch_created` metadata. `total_size_bytes_bucket` is the
 *  bucket for the SUM of `size_bytes` across every entry — operators
 *  read this to chart batch shape without joining back to per-file
 *  rows. `dedup_hits` mirrors the response field. */
export const FileBatchCreatedMetadataSchema = z.object({
  count: z.number().int().nonnegative(),
  total_size_bytes_bucket: SizeBucketSchema.optional(),
  dedup_hits: z.number().int().nonnegative(),
  request_source: RequestSourceSchema.optional(),
});
export type FileBatchCreatedMetadata = z.infer<typeof FileBatchCreatedMetadataSchema>;

/** `file.upload_received` metadata. Emitted from the authenticated
 *  engine upload sink AFTER the streaming S3 put completes — closes the audit
 *  gap where a client uploads bytes and abandons the session before
 *  finalize. `source` distinguishes future emission paths (today only
 *  path. */
export const FileUploadReceivedMetadataSchema = z.object({
  file_id: z.string().uuid(),
  size_bytes_bucket: SizeBucketSchema,
  source: z.enum(["authenticated_engine_upload"]),
  request_source: RequestSourceSchema.optional(),
});
export type FileUploadReceivedMetadata = z.infer<typeof FileUploadReceivedMetadataSchema>;

/** `content_part.sent` metadata — emitted from the LLM file-context
 *  assembler immediately after a fresh upload to a provider Files API
 *  (Anthropic / OpenAI / Gemini). Closes the per-file byte-egress audit
 *  gap: prior to this row the only persisted evidence of an outbound
 *  file shipment was the `<provider>_file_id` column on the `files`
 *  row, which a SIEM consumer can't chart at per-tenant byte
 *  granularity. The wrapping `LLM_INVOCATION` row still fires from the
 *  invocation side; this audit isolates the upload as a discrete event.
 *  Cached-fid reuse (no new upload) does NOT emit — only the fresh
 *  upload that consumes bandwidth lands a row. */
export const ContentPartSentMetadataSchema = z.object({
  /** Provider the bytes were shipped to. */
  provider: z.enum(["anthropic", "openai", "gemini"]),
  /** Local `files.id` whose bytes were uploaded — primary correlation
   *  key for joining back to the canonical row. */
  file_id: z.string().uuid(),
  /** MIME type the uploader sent to the provider (defaults to
   *  `application/octet-stream` upstream when the row column is null). */
  content_type: z.string(),
  /** Coarse size bucket — never a raw byte count (cardinality). */
  size_bytes_bucket: SizeBucketSchema,
  /** Canonical request_source — see `RequestSourceSchema` for the full
   *  list. Optional because file-context assembly can happen on a
   *  scheduler-driven turn that doesn't carry an HTTP context. */
  request_source: RequestSourceSchema.optional(),
});
export type ContentPartSentMetadata = z.infer<typeof ContentPartSentMetadataSchema>;

/** `engine.update.*` metadata. Shared by initiated/completed/failed/
 *  rolled_back. The binary swap is the prototypical privileged action:
 *  there is no HTTP context, so the row is the audit story. */
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
   *  do NOT carry an `actor: "cli"` literal because any HTTP / MCP
   *  self-update surface is an anti-goal — the column would invite
   *  drift. DO NOT WIDEN. */
  request_source: z.enum(["self-update", "rollback"]),
  /** Reason an update failed. Set on FAILED only. */
  reason: z.string().optional(),
});
export type EngineUpdateMetadata = z.infer<typeof EngineUpdateMetadataSchema>;

/** `operator.risk_signal_raised` metadata. A leading-indicator predictive
 *  signal crossed its threshold (false→true edge). `severity` mirrors
 *  `RiskSeverity` in `operator/risk-signals.ts` ("info" was pruned). */
export const RiskSignalRaisedMetadataSchema = z.object({
  kind: z.string(),
  severity: z.enum(["warn", "critical"]),
  metric: z.string(),
  value: z.number(),
  threshold: z.number(),
  /** Process uptime (s) at the edge — a low value flags a post-restart
   *  re-raise of a standing critical vs. a live transition (see call site). */
  uptime_s: z.number().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type RiskSignalRaisedMetadata = z.infer<typeof RiskSignalRaisedMetadataSchema>;

/** `operator.risk_signal_cleared` metadata. The paired clear edge — the
 *  signal fell back below its threshold (true→false). Only the `kind` is
 *  carried; the cleared value is by definition under threshold. */
export const RiskSignalClearedMetadataSchema = z.object({
  kind: z.string(),
  request_source: RequestSourceSchema.optional(),
});
export type RiskSignalClearedMetadata = z.infer<typeof RiskSignalClearedMetadataSchema>;

/** `user.invited` metadata. Emitted from `createInvite` when an admin
 *  issues a single-use provisioning invite. Records exactly the grant the
 *  admin authorized so compliance can prove the redeemed api key never
 *  exceeded it — the invite prefix (never the plaintext or hash) plus the
 *  scopes + optional allow lists. */
export const UserInvitedMetadataSchema = z.object({
  invite_id: z.string().uuid(),
  user_id: z.string().uuid(),
  /** Unhashed prefix of the invite token — safe to log, identifies the
   *  row without leaking the redeemable secret. */
  prefix: z.string(),
  scopes: z.array(z.string()),
  allowed_workflows: z.array(z.string()).nullable().optional(),
  allowed_connectors: z.array(z.string()).nullable().optional(),
  expires_at: z.string(),
  request_source: RequestSourceSchema.optional(),
});
export type UserInvitedMetadata = z.infer<typeof UserInvitedMetadataSchema>;

/** `user_invite.redeemed` metadata. Emitted from `redeemInvite` when the
 *  invited user mints their personal api key. The `api_key_id` correlates
 *  to the paired `API_KEY_ISSUED` row; the plaintext key never appears in
 *  the audit trail. */
export const InviteRedeemedMetadataSchema = z.object({
  invite_id: z.string().uuid(),
  user_id: z.string().uuid(),
  api_key_id: z.string().uuid(),
  prefix: z.string(),
  request_source: RequestSourceSchema.optional(),
});
export type InviteRedeemedMetadata = z.infer<typeof InviteRedeemedMetadataSchema>;

/** `user_invite.revoked` metadata. Emitted from `revokeInvite` when an
 *  admin cancels an un-redeemed invite. Records the invite identity (id +
 *  prefix) and the user the grant was for; no plaintext or hash. */
export const UserInviteRevokedMetadataSchema = z.object({
  invite_id: z.string().uuid(),
  user_id: z.string().uuid(),
  /** Unhashed prefix of the invite token — safe to log, identifies the
   *  row without leaking the redeemable secret. */
  prefix: z.string(),
  request_source: RequestSourceSchema.optional(),
});
export type UserInviteRevokedMetadata = z.infer<typeof UserInviteRevokedMetadataSchema>;

/** `user.identity_linked` metadata. Emitted when an auth adapter binds a
 *  verified subject to a pre-existing email-matched user row. The `source`
 *  names the configured adapter and `subject` is namespaced by that source. */
export const UserIdentityLinkedMetadataSchema = z.object({
  source: z.string(),
  subject: z.string(),
  email: z.string().optional(),
  request_source: RequestSourceSchema.optional(),
});
export type UserIdentityLinkedMetadata = z.infer<typeof UserIdentityLinkedMetadataSchema>;

/** `chat.message.denied` metadata for the `workspace_not_installed`
 *  drop — a message into a named space the app was added to but that is
 *  not yet registered. Emitted under `SYSTEM_TENANT_ID` from the
 *  chat.event worker. `sender_platform_user_id` and `space_display_name`
 *  are the two fields the `sk chat` pending-space discovery reads back;
 *  both are OPTIONAL/NULLABLE so the other `CHAT_MESSAGE_DENIED` writers
 *  (replay, identity-not-linked) are unaffected.
 *
 *  ISOLATION-CRITICAL: `sender_platform_user_id` is populated ONLY for
 *  platforms whose native user id is tenant-global
 *  (`PLATFORM_HAS_GLOBAL_USER_IDS`); a workspace-scoped Slack/Teams id
 *  must never enter this tenant-blind SYSTEM pool, so it is written as
 *  `null` there. The pending-spaces query matches on this field with a
 *  NULL-safe equality (a `null` sender can never be attributed to a
 *  caller). */
export const ChatMessageDeniedMetadataSchema = z.object({
  platform: z.string(),
  workspace_id_native: z.string(),
  event_key: z.string().nullable().optional(),
  kind: z.string(),
  /** Global-id-platform sender (`users/<People-id>`) or `null`. */
  sender_platform_user_id: z.string().nullable().optional(),
  /** Human-friendly space name for the pending-space picker label. */
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
