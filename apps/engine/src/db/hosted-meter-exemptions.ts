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

export const HOSTED_METER_EXEMPTIONS: Readonly<Record<string, string>> = {
  caller_budget_units: ledger,
  external_call_metering: ledger,
  hosted_tenant_usage: ledger,
  hosted_work_admissions: ledger,
  llm_usage: ledger,
  usage_events: ledger,
  connector_credential_setup_grants: authFlow,
  connector_oauth_start_grants: authFlow,
  connector_oauth_states: authFlow,
  mcp_oauth_access_tokens: authFlow,
  mcp_oauth_authorization_codes: authFlow,
  mcp_oauth_grants: authFlow,
  mcp_oauth_refresh_tokens: authFlow,
  mcp_oauth_states: authFlow,
  mcp_oauth_unknown_grants: authFlow,
  oidc_login_states: authFlow,
  sessions: authFlow,
  chat_events_seen: dedup,
  files_dedup_seen: dedup,
  webhook_replay_seen: dedup,
  product_identity_tombstones: erasure,
  tenant_erasure_states: erasure,
  task_grants: taskState,
  task_runs: taskState,
  conversation_turns:
    "Turn scheduling state without content (one active turn per conversation); the conversation content is metered in conversations and conversation_messages.",
  transactional_mail_receipts:
    "Delivery outcome receipt without content: must stay writable to record whether an already sent mail was delivered, so a retry never sends it twice.",
};
