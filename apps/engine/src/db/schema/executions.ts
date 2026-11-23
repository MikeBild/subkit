import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { CredentialUseSnapshot } from "../../credentials/provider-identity.ts";
import type { ExecutionAuthorizationContext } from "../../execution/authorization-context.ts";
import type { CallerOrigin } from "../../execution/caller-origin.ts";
import { EXECUTION_STATUSES } from "../../execution/core/status.ts";
import { executionModeEnum, tenantId, timestamps } from "./_common.ts";
import { connectors } from "./connectors.ts";
import { tenants } from "./identity.ts";
import { workflowExecutionAuthorities, workflows, workflowVersions } from "./workflows.ts";

export const executionStatusEnum = pgEnum("execution_status", EXECUTION_STATUSES);

const guardUnitStatusList = sql.raw(
  ["queued", "running"].map((status) => `'${status}'`).join(", "),
);

export const patchClassificationEnum = pgEnum("patch_classification", ["safe", "unsafe"]);
export const patchStatusEnum = pgEnum("patch_status", [
  "proposed",
  "applied",
  "rejected",
  "superseded",
  "inapplicable",
]);

export const executions = pgTable(
  "executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id").references(() => workflows.id, {
      onDelete: "cascade",
    }),
    workflow_version_id: uuid("workflow_version_id").references(() => workflowVersions.id, {
      onDelete: "cascade",
    }),
    execution_authority_id: uuid("execution_authority_id"),
    tool_approval_id: uuid("tool_approval_id"),
    tool_approval_dispatches: jsonb("tool_approval_dispatches")
      .$type<Record<string, { digest: string; attempts: number; step_key: string }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    hold_writes: boolean("hold_writes").notNull().default(false),
    source_kind: text("source_kind").notNull().default("saved"),
    source_ref: jsonb("source_ref").$type<Record<string, unknown> | null>(),
    caller_context: jsonb("caller_context").$type<{
      tenantId: string;
      principalId: string;
      principalKind: "user" | "system_account";
      provider: string;
      productId: string | null;
      subject?: string | null | undefined;
    } | null>(),
    caller_origin: text("caller_origin").$type<CallerOrigin>().notNull().default("unknown"),
    input: jsonb("input"),
    authorization_context: jsonb(
      "authorization_context",
    ).$type<ExecutionAuthorizationContext | null>(),
    sensitive_result: jsonb("sensitive_result"),
    status: executionStatusEnum("status").notNull(),
    request_source: text("request_source").notNull(),
    origin_source: text("origin_source"),
    audit_trace_id: text("audit_trace_id"),
    execution_mode: executionModeEnum("execution_mode").notNull(),
    parent_execution_id: uuid("parent_execution_id"),
    authority_root_execution_id: uuid("authority_root_execution_id"),
    authority_call_path: jsonb("authority_call_path").$type<string[] | null>(),
    result_storage_uri: text("result_storage_uri"),
    result_sha256: text("result_sha256"),
    abort_requested_at: timestamp("abort_requested_at", { withTimezone: true }),
    heartbeat_at: timestamp("heartbeat_at", { withTimezone: true }),
    attempt: integer("attempt").default(0).notNull(),
    idempotency_key: text("idempotency_key"),
    failure: jsonb("failure").$type<{
      step_id: string | null;
      error_code: string;
      error_message: string;
      error_class?: string;
      connector?: { connector_id: string | null; reason: string };
    } | null>(),
    output_contract: text("output_contract"),
    result_markdown: text("result_markdown"),
    result_markdown_truncated: boolean("result_markdown_truncated").notNull().default(false),
    budget_park: jsonb("budget_park").$type<{
      step_id: string;
      month: string;
      parked_at: string;
      scope: Record<string, unknown>;
    } | null>(),
    guard_bucket: text("guard_bucket"),
    guard_unit_key: text("guard_unit_key"),
    started_at: timestamp("started_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      "executions_caller_origin_check",
      sql`${t.caller_origin} IN ('principal', 'trusted_system', 'unknown')`,
    ),
    uniqueIndex("executions_single_tool_approval_uidx")
      .on(t.tool_approval_id)
      .where(sql`${t.tool_approval_id} IS NOT NULL`),
    check(
      "executions_tool_approval_shape_check",
      sql`${t.tool_approval_id} IS NULL OR
      (${t.source_kind} = 'saved' AND ${t.workflow_id} IS NOT NULL AND
       ${t.workflow_version_id} IS NOT NULL AND ${t.execution_authority_id} IS NULL AND NOT ${t.hold_writes})`,
    ),
    index("executions_authority_idx").on(t.tenant_id, t.execution_authority_id),
    foreignKey({
      name: "executions_exact_authority_fk",
      columns: [
        t.tenant_id,
        t.execution_authority_id,
        t.workflow_id,
        t.workflow_version_id,
        t.execution_mode,
      ],
      foreignColumns: [
        workflowExecutionAuthorities.tenant_id,
        workflowExecutionAuthorities.id,
        workflowExecutionAuthorities.workflow_id,
        workflowExecutionAuthorities.workflow_version_id,
        workflowExecutionAuthorities.execution_environment,
      ],
    }).onDelete("restrict"),
    check(
      "executions_authority_saved_check",
      sql`${t.execution_authority_id} IS NULL OR
      (${t.source_kind} = 'saved' AND ${t.workflow_id} IS NOT NULL AND ${t.workflow_version_id} IS NOT NULL)`,
    ),
    index("executions_authority_link_idx").on(t.tenant_id, t.authority_root_execution_id),
    check(
      "executions_authority_link_shape_check",
      sql`(${t.authority_root_execution_id} IS NULL) = (${t.authority_call_path} IS NULL) AND
      (${t.authority_root_execution_id} IS NULL OR (
        ${t.execution_authority_id} IS NULL AND ${t.tool_approval_id} IS NULL AND
        NOT ${t.hold_writes} AND ${t.source_kind} = 'saved' AND
        ${t.workflow_id} IS NOT NULL AND ${t.workflow_version_id} IS NOT NULL AND
        ${t.parent_execution_id} IS NOT DISTINCT FROM ${t.authority_root_execution_id} AND
        jsonb_typeof(${t.authority_call_path}) = 'array' AND
        jsonb_array_length(${t.authority_call_path}) >= 1))`,
    ),
    index("executions_tenant_workflow_started_idx").on(t.tenant_id, t.workflow_id, t.started_at),
    index("executions_tenant_status_idx").on(t.tenant_id, t.status),
    index("executions_tenant_status_started_idx").on(t.tenant_id, t.status, t.started_at),
    index("executions_tenant_request_source_idx").on(t.tenant_id, t.request_source),
    index("executions_tenant_source_kind_idx").on(t.tenant_id, t.source_kind),
    index("executions_active_guard_unit_idx")
      .on(t.tenant_id, t.guard_unit_key)
      .where(sql`${t.status} IN (${guardUnitStatusList}) AND ${t.guard_unit_key} IS NOT NULL`),
    uniqueIndex("executions_tenant_idempotency_key_uidx")
      .on(t.tenant_id, t.idempotency_key)
      .where(sql`${t.idempotency_key} IS NOT NULL`),
  ],
);

export const executionSteps = pgTable(
  "execution_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    execution_id: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    step_key: text("step_key").notNull(),
    step_index: integer("step_index"),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    input_preview: jsonb("input_preview"),
    output_preview: jsonb("output_preview"),
    result_storage_uri: text("result_storage_uri"),
    result_sha256: text("result_sha256"),
    result_preview: text("result_preview"),
    request_meta: jsonb("request_meta"),
    credential_snapshots: jsonb("credential_snapshots")
      .$type<CredentialUseSnapshot[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    duration_ms: integer("duration_ms"),
    retry_count: integer("retry_count").default(0).notNull(),
    error: jsonb("error"),
    placeholders_used: jsonb("placeholders_used")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    redacted_fields: jsonb("redacted_fields")
      .$type<Array<{ path: string; action: string; reason?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    started_at: timestamp("started_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    held: boolean("held").default(false).notNull(),
    write_dispatched_at: timestamp("write_dispatched_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "execution_steps_credential_snapshots_array",
      sql`jsonb_typeof(${t.credential_snapshots}) = 'array'`,
    ),
    index("execution_steps_execution_started_idx").on(t.execution_id, t.started_at),
    index("execution_steps_running_execution_idx")
      .on(t.execution_id)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const executionFixtures = pgTable(
  "execution_fixtures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id").references(() => connectors.id, {
      onDelete: "cascade",
    }),
    endpoint_key: text("endpoint_key"),
    request: jsonb("request"),
    response: jsonb("response"),
    kind: text("kind").default("fixture").notNull(),
    execution_id: uuid("execution_id"),
    step_id: uuid("step_id"),
    body: jsonb("body"),
    byte_size: integer("byte_size"),
    captured_at: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("execution_fixtures_connector_endpoint_idx").on(t.connector_id, t.endpoint_key),
    index("execution_fixtures_kind_idx").on(t.kind),
    index("execution_fixtures_execution_idx").on(t.execution_id),
  ],
);

export const patchCandidates = pgTable(
  "patch_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id").references(() => connectors.id, {
      onDelete: "cascade",
    }),
    endpoint_key: text("endpoint_key"),
    diff: jsonb("diff").notNull(),
    classification: patchClassificationEnum("classification").notNull(),
    fixture_id: uuid("fixture_id"),
    status: patchStatusEnum("status").notNull(),
    outcome_window_ended_at: timestamp("outcome_window_ended_at", {
      withTimezone: true,
    }),
    outcome_successes_after: integer("outcome_successes_after").default(0).notNull(),
    outcome_failures_after: integer("outcome_failures_after").default(0).notNull(),
    closed_reason: text("closed_reason"),
    closed_against_version_id: uuid("closed_against_version_id"),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    accepted_operations: jsonb("accepted_operations").$type<number[] | null>(),
    accepted_digest: text("accepted_digest"),
    ...timestamps,
  },
  (t) => [
    index("patch_candidates_tenant_workflow_status_idx").on(t.tenant_id, t.workflow_id, t.status),
    index("patch_candidates_tenant_status_created_idx").on(t.tenant_id, t.status, t.created_at),
    index("patch_candidates_endpoint_idx").on(
      t.tenant_id,
      t.workflow_id,
      t.connector_id,
      t.endpoint_key,
      t.status,
    ),
  ],
);
