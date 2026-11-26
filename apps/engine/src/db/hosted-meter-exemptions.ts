const ledger =
  "Quota and budget ledger: metering it would charge the meter itself, and it must stay writable to settle or release usage when the allowance is exhausted.";
const authFlow =
  "Sign-in and authorization flow state: must stay writable so a tenant at its limit can still sign in, authorize, revoke and clean up; values are size-bounded by hosted_operational_guard.";
const dedup =
  "Replay and deduplication marker without content: refusing it at the limit would turn quota exhaustion into duplicate processing.";
const erasure =
  "Erasure bookkeeping that must stay writable while a tenant is deleted, even when its allowance is exhausted.";

const taskState =
  "Task run and standing-permission state without content (ids, closed states, reason codes, counters, each bounded by a check constraint): must stay writable so a tenant at its limit can still end or stop a run and revoke a permission; the task content is metered in tasks and the run conversation in conversations and conversation_messages.";

const scheduleHistory =
  "Schedule history without content (ids, instants, closed states, reason codes and a bounded counter, each held by a check constraint): must stay writable so a tenant at its limit still sees why a due run was skipped or held; repeated skips merge into one row and old rows are pruned by retention.";

const personalPermissionState =
  "Per-person confirmation settings and standing approval rules without content (closed states, counters, a scope and choices each bounded by a check constraint): must stay writable so a person at the tenant limit can still switch back to asking and revoke a rule.";

const deviceState =
  "Device registry state without content (a device label, a public key, instants, a stop generation and the allowance list the person keeps on that device, each bounded by a check constraint): must stay writable so a tenant at its limit can still revoke a device, stop its local steps and remove an allowance.";

const deviceCommandState =
  "Device command channel state (a command id, a closed state, instants, a stop generation, and encrypted arguments and results bounded by check constraints): must stay writable so a tenant at its limit can still stop, cancel or close a local step; the step output it carries is metered in execution_steps.";

const deviceUploadStaging =
  "Staged chunks of a file a device imports, bounded per chunk and per upload by check constraints, admitted against the file-byte quota when the upload opens and removed when it is committed, aborted or expires after an hour; the committed file is metered in files.";

const attentionSnooze =
  "Per-person snooze of an attention entry without content (a key, an instant, bounded by the primary key): must stay writable so a person at the tenant limit can still silence or restore a reminder.";

const heldDeliveryStaging =
  "Signed inbound deliveries held while their workflow waits for a first approval, bounded per hook by a row cap, per row by a byte check constraint and in time by expiry; a replay admits each one as an execution, where its input is metered.";

export const HOSTED_METER_EXEMPTIONS: Readonly<Record<string, string>> = {
  attention_snoozes: attentionSnooze,
  caller_budget_units: ledger,
  external_call_metering: ledger,
  hosted_tenant_usage: ledger,
  hosted_work_admissions: ledger,
  llm_usage: ledger,
  usage_events: ledger,
  connector_credential_setup_grants: authFlow,
  connector_oauth_start_grants: authFlow,
  connector_oauth_states: authFlow,
  desktop_login_codes: authFlow,
  mcp_oauth_access_tokens: authFlow,
  mcp_oauth_authorization_codes: authFlow,
  mcp_oauth_grants: authFlow,
  mcp_oauth_refresh_tokens: authFlow,
  mcp_oauth_states: authFlow,
  mcp_oauth_unknown_grants: authFlow,
  oidc_login_states: authFlow,
  sessions: authFlow,
  device_runners: deviceState,
  device_allowances: deviceState,
  device_commands: deviceCommandState,
  device_uploads: deviceUploadStaging,
  device_upload_chunks: deviceUploadStaging,
  device_waits: deviceState,
  chat_events_seen: dedup,
  files_dedup_seen: dedup,
  webhook_replay_seen: dedup,
  webhook_held_deliveries: heldDeliveryStaging,
  device_runner_nonces: dedup,
  product_identity_tombstones: erasure,
  tenant_erasure_states: erasure,
  schedule_occurrences: scheduleHistory,
  task_grants: taskState,
  tool_approval_rules: personalPermissionState,
  user_setup_preferences: personalPermissionState,
  task_runs: taskState,
  chat_composer_attachments:
    "Per-person staging pointer without content (ids, a bounded slug and an expiry): the staged bytes are metered in files, and the row must stay writable so a person at the limit can still clear the tray.",
  conversation_turns:
    "Turn scheduling state without content (one active turn per conversation); the conversation content is metered in conversations and conversation_messages.",
  workflow_authority_pair_requests:
    "Pending pair approval of one workflow version: the proposed grant is bounded to 4 KB by a check constraint and becomes metered in workflow_execution_authorities once approved, and the row must stay writable so a tenant at its limit can still decline, withdraw or let a request expire.",
  transactional_mail_receipts:
    "Delivery outcome receipt without content: must stay writable to record whether an already sent mail was delivered, so a retry never sends it twice.",
};
