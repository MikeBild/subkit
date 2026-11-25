import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Locale } from "@/lib/i18n";

export const INSTALLATION = "7c1e2a90-3b4d-4f5e-8a6b-0c9d8e7f6a5b";
export const INSTALLATION_BASE = `/cockpit/i/${INSTALLATION}`;
export const PLAIN_BASE = "/cockpit";
export const TENANT = "11111111-1111-4111-8111-111111111111";
export const USER = "22222222-2222-4222-8222-222222222222";
export const WORKFLOW = "33333333-3333-4333-8333-333333333333";
export const RUN = "44444444-4444-4444-8444-444444444444";
export const INTAKE = "55555555-5555-4555-8555-555555555555";
export const NOW = "2026-11-23T10:00:00.000Z";

export const ALL_PERMISSIONS: readonly string[] = (
  JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../engine/src/rbac/permissions.json"), "utf8"),
  ) as { name: string }[]
).map((permission) => permission.name);

export const BASE_PERMISSIONS = [
  "workflow:read",
  "workflow:write",
  "workflow:run",
  "execution:read",
  "intake:read",
  "intake:write",
  "conversation:write",
  "connector:read",
  "audit:read",
] as const;

export function bootstrapFor(locale: Locale, permissions: readonly string[]) {
  return {
    principal: {
      id: USER,
      kind: "user",
      email: "mira@example.com",
      display_name: "Mira",
      role_name: "owner",
      is_owner: true,
      provider: "browser_session",
    },
    tenant: {
      id: TENANT,
      slug: "acme",
      display_name: "Acme",
      timezone: "Europe/Berlin",
      language: locale,
      origin: "self_hosted",
      engine_operator: false,
    },
    session: { expires_at: "2026-12-23T10:00:00.000Z", absolute_expires_at: null },
    start_steps: {
      hidden: true,
      connector: true,
      workflow: true,
      run: true,
      people: true,
      client: true,
    },
    ai_access: { configured: true, provider: "anthropic", model: null, own_key: false },
    identity_memberships: false,
    permissions: [...permissions],
    csrf_token: "csrf",
    version: "12.1.5",
    oauth_callback_url: null,
    recent_conversations: [],
  };
}

export function attentionItem(overrides: Record<string, unknown>) {
  return {
    class: "decide",
    severity: "notice",
    trigger: null,
    cause_class: null,
    counts: {},
    since: NOW,
    deadline: null,
    detail: null,
    ...overrides,
  };
}

export function attentionWith(items: unknown[]) {
  return {
    schema_version: "attention.v1",
    generated_at: NOW,
    sources: Object.fromEntries(
      [
        "conversations",
        "schedules",
        "freshness",
        "failures",
        "patches",
        "connectors",
        "connections",
        "secret_approvals",
        "skills",
        "intake",
        "budget",
        "ai_access",
        "risk",
        "tasks",
      ].map((source) => [source, "answered"]),
    ),
    status: null,
    items,
  };
}

export const attention = attentionWith([
  attentionItem({
    id: "intake",
    kind: "intake",
    subject: null,
    reason: "intake_collected",
    counts: { intake: 2, intake_by_category: { email: 2 } },
    actions: [
      {
        verb: "review",
        href: "/cockpit/intake?category=all",
        primary: true,
        permission: "intake:read",
      },
    ],
  }),
  attentionItem({
    id: `workflow:${WORKFLOW}`,
    class: "stopped",
    severity: "urgent",
    kind: "workflow",
    subject: { kind: "workflow", id: WORKFLOW, name: "TestFlight invite via Gmail v2" },
    reason: "version_needs_repair",
    repair: {
      remedy_kind: "reconnect",
      steps: 1,
      step_id: "send",
      code: "connector_missing",
      candidate_id: null,
      execution_id: null,
    },
    actions: [
      {
        verb: "open",
        href: `/cockpit/workflows/${WORKFLOW}#workflow-automation`,
        primary: true,
        permission: "workflow:write",
      },
    ],
  }),
]);

export const setup = {
  ask_before_writing: true,
  default_environment: "prod",
  approver: { kind: "self" },
  notifications: { kind: "immediate" },
  timezone: "Europe/Berlin",
  critical_breakthrough: true,
  first_job: null,
  services: [],
  unset: [],
  recommended: {
    ask_before_writing: true,
    default_environment: "prod",
    approver: { kind: "self" },
    notifications: { kind: "immediate" },
    critical_breakthrough: true,
  },
};

export const workflow = {
  id: WORKFLOW,
  operating_status: "repair_required",
  connector_references: [],
  creator: { kind: "user", id: USER },
  checksum: null,
  tenant_id: TENANT,
  slug: "testflight-invite",
  category: "operations",
  category_source: "author",
  name: "TestFlight invite via Gmail v2",
  description: null,
  description_source: "author",
  lifecycle: "active",
  current_version_id: null,
  draft_version_id: null,
  current_version: 2,
  created_at: NOW,
  updated_at: NOW,
  last_executed_at: null,
  health_state: "unknown",
  health_reason: null,
  health_changed_at: null,
  invalid: false,
  steps: [],
  input_schema: null,
  output_schema: null,
  output_transform: null,
  output_transform_function: null,
  response_filters: null,
  validation_expression: null,
  validation_function: null,
  timeout_ms: null,
  max_llm_tokens_per_run: null,
  trigger: { kind: "request" },
  schedule: null,
  webhooks_active: 0,
  effective_trigger: { kind: "request", source: "default", state: "active" },
  connectors: [],
  authority_environments: { dev: null, prod: null },
};

export const intakeEntry = {
  id: INTAKE,
  tenant_id: TENANT,
  category: "operations",
  client_request_id: "c",
  title: "Delivery notes without an order number",
  body: "Text",
  note: "",
  state: "collected",
  version: 1,
  collected_by: { kind: "user", id: USER },
  admitted_target_kind: null,
  admitted_target_id: null,
  created_at: NOW,
  updated_at: NOW,
  original_snapshot: { origin: "note", title: "t", captured_at: NOW, body: "b" },
  attachment: null,
};

export const run = {
  id: RUN,
  execution_id: RUN,
  error: null,
  workflow_id: WORKFLOW,
  workflow_name: workflow.name,
  workflow_version_id: null,
  execution_authority_id: null,
  execution_environment: "prod",
  permission_basis: null,
  permission_phase: null,
  permission_checked_at: null,
  source_kind: "saved",
  source_ref: null,
  status: "succeeded",
  request_source: "cockpit",
  caller: {
    kind: "user",
    principal_id: USER,
    provider: null,
    product_id: null,
    verified_by: "browser_session",
    channel: "cockpit",
    origin_execution_id: null,
  },
  parent_execution_id: null,
  started_at: NOW,
  finished_at: NOW,
  created_at: NOW,
};

export const runDetail = {
  ...run,
  trace_id: null,
  outcome: {
    kind: "succeeded",
    failed_step: null,
    cause_class: "ok",
    error_code: null,
    refusal_reason: null,
    connector: null,
    steps: { total: 1, succeeded: 1, failed: 0, held: 0, skipped: 0 },
    output_contract: "none",
    rerun_safety: { mode: "repeat_safe", reason: "read_only" },
  },
  result_markdown: "Invite sent",
  result_markdown_truncated: false,
};

export const runningOutcome = {
  ...runDetail.outcome,
  kind: "running",
  cause_class: null,
  steps: { total: 1, succeeded: 0, failed: 0, held: 0, skipped: 0 },
};

export type Handler = (url: URL, init: RequestInit | undefined) => unknown;

export const BASE_ROUTES: Record<string, Handler> = {
  "/v1/executions": () => ({ items: [run], next_cursor: null }),
  [`/v1/executions/${RUN}`]: () => runDetail,
  [`/v1/executions/${RUN}/steps`]: () => ({ items: [], next_cursor: null }),
  "/v1/workflows": () => ({ items: [workflow], total: 1, categories: [] }),
  [`/v1/workflows/${WORKFLOW}`]: () => workflow,
  "/v1/schedules": () => ({ schedules: [], total: 0 }),
  [`/v1/workflows/${WORKFLOW}/diagnosis`]: () => ({
    workflow_id: WORKFLOW,
    workflow_version_id: null,
    environment: "dev",
    is_current: true,
    diagnoses: [
      {
        code: "connector_missing",
        subject: { step_id: "send" },
        evidence: {},
        remedy_kind: "reconnect",
      },
    ],
  }),
  "/v1/categories": () => ({ categories: [] }),
  "/v1/intake/default-category": () => ({ category: "operations" }),
  "/v1/intake/items": () => ({ items: [intakeEntry] }),
  [`/v1/intake/items/${INTAKE}`]: () => intakeEntry,
  "/v1/intake/proposals": () => ({ items: [] }),
};
