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
import { executionModeEnum, tenantId, timestamps } from "./_common.ts";
import { connectors } from "./connectors.ts";
import { tenants } from "./identity.ts";
import { workflowExecutionAuthorities, workflows, workflowVersions } from "./workflows.ts";

export const executionStatusEnum = pgEnum("execution_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
]);

export const patchClassificationEnum = pgEnum("patch_classification", ["safe", "unsafe"]);
export const patchStatusEnum = pgEnum("patch_status", [
  "proposed",
  "applied",
  "rejected",
  "superseded",
]);

// ----- executions -----------------------------------------------------------
//
// definition-driven: an execution can originate from
//   • a saved workflow (source_kind='saved', workflow_id + workflow_version_id set)
//   • an inline draft definition (source_kind='draft', workflow_id=NULL)
//   • a single step test-run    (source_kind='step',  workflow_id=NULL)
//
// The saved-has-workflow CHECK lives at the DB level (migration 0034) so
// the constraint is enforced even when code paths bypass Drizzle.

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
    // Approval secrets have shorter retention than run history. Missing proof
    // fails closed; this marker must never be cleared by retention cleanup.
    tool_approval_id: uuid("tool_approval_id"),
    tool_approval_dispatches: jsonb("tool_approval_dispatches")
      .$type<Record<string, { digest: string; attempts: number; step_key: string }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // A queued preview must not become live because a worker omitted an option.
    hold_writes: boolean("hold_writes").notNull().default(false),
    source_kind: text("source_kind").notNull().default("saved"),
    source_ref: jsonb("source_ref").$type<Record<string, unknown> | null>(),
    // The run input as supplied by the caller (null when the run had
    // none). Persisted so POST /v1/executions/{id}/rerun can default to
    // the original input instead of silently re-running with nothing.
    input: jsonb("input"),
    status: executionStatusEnum("status").notNull(),
    request_source: text("request_source").notNull(),
    execution_mode: executionModeEnum("execution_mode").notNull(),
    parent_execution_id: uuid("parent_execution_id"),
    // This run was started BY a `call` step of an approved run, and carries no
    // approval of its own: the root's does the deciding, and every dispatch
    // here is measured against the effect the root's manifest holds at this
    // path. Both columns are set together or not at all, and neither can be
    // changed after the insert — a trigger enforces both, because a run that
    // could acquire or move its link afterwards would be borrowing someone
    // else's permission. No foreign key, mirroring `parent_execution_id`, so
    // run-history retention on the root cannot fail on a child row.
    authority_root_execution_id: uuid("authority_root_execution_id"),
    authority_call_path: jsonb("authority_call_path").$type<string[] | null>(),
    result_storage_uri: text("result_storage_uri"),
    result_sha256: text("result_sha256"),
    // Durable control-plane intent. The HTTP cancel request may land on a
    // different replica from the worker that owns the in-memory
    // AbortController, so the database is the cross-replica source of truth.
    abort_requested_at: timestamp("abort_requested_at", { withTimezone: true }),
    // Caller-chosen key that makes a trigger safe to repeat. Two runs with
    // the same key in one tenant cannot both exist: the partial unique index
    // below refuses the second insert, and the run route answers with the
    // first execution instead. NULL for every run that did not ask for it.
    idempotency_key: text("idempotency_key"),
    started_at: timestamp("started_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
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
    // A linked child names the run whose approval covers it, runs a pinned
    // saved version, holds NO approval of its own, and is never a preview. Its
    // parent IS that root: the link and the ordinary run tree must agree, or
    // "who started this" and "whose permission is this" could differ.
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
    // Covers GET /v1/stats/executions: date_trunc(bucket, started_at)
    // bucketing + status filter/group + percentile over duration, all
    // tenant-scoped. Added in migration 0034. The plain (tenant_id,
    // status) index above lacks the time prefix; the workflow_started
    // index lacks status.
    index("executions_tenant_status_started_idx").on(t.tenant_id, t.status, t.started_at),
    index("executions_tenant_request_source_idx").on(t.tenant_id, t.request_source),
    index("executions_tenant_source_kind_idx").on(t.tenant_id, t.source_kind),
    uniqueIndex("executions_tenant_idempotency_key_uidx")
      .on(t.tenant_id, t.idempotency_key)
      .where(sql`${t.idempotency_key} IS NOT NULL`),
  ],
);

// ----- execution_steps ------------------------------------------------------

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
    duration_ms: integer("duration_ms"),
    retry_count: integer("retry_count").default(0).notNull(),
    error: jsonb("error"),
    // Conversation-quality extensions (migration 0028):
    //   placeholders_used — token names (never values) for every ${cred.*},
    //     ${connector.*}, ${input.*}, ${scope.*} placeholder the step
    //     actually resolved at dispatch time. Used for audit forensics and
    //     to prove the step did not hardcode a secret.
    //   redacted_fields   — dotted paths of output fields masked/dropped/hashed
    //     by the DLP layer before handing the step output to downstream steps
    //     or the LLM context. Shape: [{ path, action, reason }].
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
  },
  (t) => [
    index("execution_steps_execution_started_idx").on(t.execution_id, t.started_at),
    index("execution_steps_running_execution_idx")
      .on(t.execution_id)
      .where(sql`${t.status} = 'running'`),
  ],
);

// ----- execution_fixtures ---------------------------------------------------

export const executionFixtures = pgTable(
  "execution_fixtures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    // `connector_id`, `endpoint_key`, `request`, `response` are populated
    // for self-healing dry-run fixtures (kind='fixture'). For
    // kind='offload' rows they are null and the payload lives on `body`.
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

// ----- patch_candidates -----------------------------------------------------

export const patchCandidates = pgTable(
  "patch_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    // The drift signal's anchor endpoint, when it has one. These mirror
    // `signal.connector_id` / `signal.endpoint_key` and exist so the
    // proactive scan can find an already-active candidate for the same
    // endpoint (status in proposed|applied) and refresh-or-skip instead
    // of inserting a fresh row every hour — the patch_candidates flood
    // fix. Null for workflow-scoped signals (stdlib_version_drift,
    // validation_failed) which carry no endpoint anchor.
    connector_id: uuid("connector_id").references(() => connectors.id, {
      onDelete: "cascade",
    }),
    endpoint_key: text("endpoint_key"),
    diff: jsonb("diff").notNull(),
    classification: patchClassificationEnum("classification").notNull(),
    fixture_id: uuid("fixture_id"),
    status: patchStatusEnum("status").notNull(),
    // Outcome window: set when the patch is applied; a background job
    // counts the next N executions on this workflow and fills in the
    // outcome_{successes,failures}_after numbers so operators can see
    // whether the patch actually prevented recurrence.
    outcome_window_ended_at: timestamp("outcome_window_ended_at", {
      withTimezone: true,
    }),
    outcome_successes_after: integer("outcome_successes_after").default(0).notNull(),
    outcome_failures_after: integer("outcome_failures_after").default(0).notNull(),
    ...timestamps,
  },
  (t) => [
    index("patch_candidates_tenant_workflow_status_idx").on(t.tenant_id, t.workflow_id, t.status),
    // Covers the connector-pattern detector scan (tenant_id, status='applied',
    // created_at >= cutoff) with no workflow_id — see migration 0036.
    index("patch_candidates_tenant_status_created_idx").on(t.tenant_id, t.status, t.created_at),
    // Covers the proactive refresh-or-skip lookup: an active candidate for
    // the same (tenant, workflow, connector, endpoint) — see migration 0050.
    index("patch_candidates_endpoint_idx").on(
      t.tenant_id,
      t.workflow_id,
      t.connector_id,
      t.endpoint_key,
      t.status,
    ),
  ],
);

// Note: the `optimization_candidates` persistence table is intentionally
// not landed in this slice. The pure analyzer in
// `self-healing/optimization-analyzer.ts` is invocable today (returns
// proposal objects); the matching pg-boss handler + DB schema land
// together in the follow-up PR that also wires the cron scheduler. We
// keep this comment so the next change-set has a deliberate landing
// spot rather than re-discovering the placement.
