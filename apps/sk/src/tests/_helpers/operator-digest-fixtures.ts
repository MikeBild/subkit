import type {
  AttentionItem,
  DigestAttention,
  DigestFailureGroup,
  DigestPatch,
  OperatorHealthDigest,
} from "../../engine-client.ts";

const STAMP = "2026-06-22T08:00:00Z";

export function attentionSources(
  overrides: Partial<DigestAttention["sources"]> = {},
): DigestAttention["sources"] {
  return {
    conversations: "answered",
    schedules: "answered",
    freshness: "answered",
    failures: "answered",
    patches: "answered",
    connectors: "answered",
    connections: "answered",
    secret_approvals: "answered",
    skills: "answered",
    intake: "answered",
    budget: "answered",
    ai_access: "answered",
    risk: "answered",
    ...overrides,
  };
}

export function attention(overrides: Partial<DigestAttention> = {}): DigestAttention {
  return {
    schema_version: "attention.v1",
    generated_at: STAMP,
    sources: attentionSources(),
    status: null,
    items: [],
    ...overrides,
  };
}

export function failureGroup(overrides: Partial<DigestFailureGroup> = {}): DigestFailureGroup {
  return {
    signature: "sig",
    workflow_id: "wf",
    workflow_name: "Workflow",
    step_key: "step",
    error_code: "ERR",
    origin: "manual",
    count: 1,
    scheduled_count: 0,
    last_seen: "2026-06-22T07:30:00Z",
    first_seen: "2026-06-22T07:30:00Z",
    latest_execution_id: "exec-1",
    connector_id: null,
    resolved_at: null,
    cause: "Something failed",
    cause_class: "unknown",
    guidance: null,
    ...overrides,
  };
}

export function digestPatch(overrides: Partial<DigestPatch> = {}): DigestPatch {
  return {
    id: "patch",
    workflow_id: null,
    workflow_name: null,
    classification: "safe",
    age_days: 0,
    stuck: false,
    summary: "",
    ...overrides,
  };
}

export function attentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "item",
    class: "failing",
    severity: "urgent",
    kind: "connector",
    subject: null,
    reason: "failing",
    trigger: null,
    cause_class: null,
    counts: {},
    since: null,
    deadline: null,
    detail: null,
    actions: [],
    ...overrides,
  };
}

export function operatorDigest(
  overrides: Partial<OperatorHealthDigest> = {},
): OperatorHealthDigest {
  return {
    generated_at: STAMP,
    window_hours: 24,
    headline: "",
    failure_groups: [],
    patch_candidates: { open: 0, items: [] },
    risk: [],
    attention: attention(),
    rendered: "",
    all_clear: false,
    ...overrides,
  };
}
