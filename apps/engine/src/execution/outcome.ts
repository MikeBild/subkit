// A run's outcome as structure, derived from what was persisted.
//
// `executions.status` alone cannot answer "what happened": a hold-writes
// preview finalizes `succeeded` although nothing was written, a run with an
// `on_error:"continue"` step finalizes `succeeded` although a step failed, and
// a failed run says nothing about which step stopped it or why. Readers used to
// fill that gap themselves — and showed an earlier step's intermediate output as
// a failed run's result. The outcome here is the engine's answer; clients
// compose their own sentences from its fields.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executionSteps, type executions, workflowVersions } from "../db/schema/index.ts";
import {
  classifyPersistedFailure,
  type PersistedFailureClass,
  type PreviewClassification,
} from "./classify.ts";
import type { OutputContractVerdict } from "./state.ts";

export type OutcomeKind = "succeeded" | "failed" | "held" | "partial" | "running";

export interface ExecutionOutcome {
  kind: OutcomeKind;
  failed_step: { step_key: string; kind: string } | null;
  cause_class: PreviewClassification | null;
  error_code: string | null;
  steps: { total: number; succeeded: number; failed: number; held: number; skipped: number };
  output_contract: OutputContractVerdict;
}

/** The failure a list row carries: which step stopped the run and its class. */
export interface ExecutionFailureSummary {
  step_key: string | null;
  cause_class: PreviewClassification | null;
}

type ExecutionRow = typeof executions.$inferSelect;
type OutcomeExecution = Pick<ExecutionRow, "status" | "failure" | "output_contract">;

export interface OutcomeStepRow {
  step_key: string;
  kind: string;
  status: string;
  error: unknown;
  held: boolean;
  /** Rows written before the `held` column carry the marker here only. */
  request_meta?: unknown;
  started_at: Date | null;
}

/** A held write: the column, or — for rows older than it — the driver's own marker. */
function isHeldRow(row: OutcomeStepRow): boolean {
  if (row.held) return true;
  const meta = row.request_meta as { extras?: { held?: unknown } } | null | undefined;
  return meta?.extras?.held === true;
}

const FAILED_STEP_STATUSES = new Set(["failed", "timed_out", "aborted"]);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out", "aborted"]);
const OUTPUT_CONTRACT_VERDICTS = new Set<string>(["passed", "violated", "none"]);

/** True when a row belongs to a definition step: its own row or a loop iteration `id[n]`. */
function rowOfStep(stepKey: string, stepId: string): boolean {
  return stepKey === stepId || stepKey.startsWith(`${stepId}[`);
}

/**
 * The step that stopped the run. The engine names it on the execution row
 * (`failure.step_id`); without that, the LAST failed row wins — an
 * `on_error:"continue"` failure earlier in the run was tolerated and did not
 * stop anything. Deterministic: ordered by `started_at`, then row order.
 */
export function pickStoppingStep<
  T extends Pick<OutcomeStepRow, "step_key" | "status" | "started_at">,
>(rows: readonly T[], failureStepId: string | null | undefined): T | null {
  const failed = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => FAILED_STEP_STATUSES.has(row.status))
    .sort(
      (a, b) =>
        (a.row.started_at?.getTime() ?? 0) - (b.row.started_at?.getTime() ?? 0) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
  if (failureStepId) {
    const named = failed.filter((row) => rowOfStep(row.step_key, failureStepId));
    if (named.length > 0) return named[named.length - 1] ?? null;
  }
  return failed[failed.length - 1] ?? null;
}

/** Classify a run's stopping failure: the stopping step row, else the execution's own failure. */
function classifyRunFailure(
  exec: Pick<ExecutionRow, "status" | "failure">,
  stopping: Pick<OutcomeStepRow, "status" | "error"> | null,
): PersistedFailureClass | null {
  if (stopping) return classifyPersistedFailure(stopping);
  if (exec.failure) {
    return classifyPersistedFailure({
      status: exec.status,
      error: { code: exec.failure.error_code, message: exec.failure.error_message },
    });
  }
  return null;
}

/**
 * Pure derivation. `definitionSteps` are the top-level steps of the version
 * that ran; for a terminal run, a step with no row never ran and counts as
 * skipped (a branch arm not taken, the tail behind a failure, a step behind a
 * held write). Draft and step runs pass no definition and count rows only.
 */
export function deriveExecutionOutcome(
  exec: OutcomeExecution,
  rows: readonly OutcomeStepRow[],
  definitionSteps: ReadonlyArray<{ id: string; kind: string }> = [],
): ExecutionOutcome {
  const running = exec.status === "queued" || exec.status === "running";
  let succeeded = 0;
  let failed = 0;
  let held = 0;
  let skipped = 0;
  for (const row of rows) {
    if (isHeldRow(row)) held += 1;
    else if (FAILED_STEP_STATUSES.has(row.status)) failed += 1;
    else if (row.status === "skipped") skipped += 1;
    else if (row.status === "succeeded") succeeded += 1;
  }
  const unrun = running
    ? 0
    : definitionSteps.filter((step) => !rows.some((row) => rowOfStep(row.step_key, step.id)))
        .length;
  skipped += unrun;

  let kind: OutcomeKind;
  if (running) kind = "running";
  else if (FAILED_RUN_STATUSES.has(exec.status)) kind = "failed";
  else if (held > 0) kind = "held";
  else if (failed > 0) kind = "partial";
  else kind = "succeeded";

  const reportsFailure = kind === "failed" || kind === "partial";
  const stopping = reportsFailure ? pickStoppingStep(rows, exec.failure?.step_id) : null;
  const cause = reportsFailure ? classifyRunFailure(exec, stopping) : null;
  const namedStepId = kind === "failed" ? exec.failure?.step_id : null;
  const failed_step = stopping
    ? { step_key: stopping.step_key, kind: stopping.kind }
    : namedStepId
      ? {
          step_key: namedStepId,
          kind: definitionSteps.find((s) => s.id === namedStepId)?.kind ?? "unknown",
        }
      : null;

  return {
    kind,
    failed_step,
    cause_class: cause?.classification ?? null,
    error_code: cause?.error_code ?? null,
    steps: { total: rows.length + unrun, succeeded, failed, held, skipped },
    output_contract:
      exec.output_contract && OUTPUT_CONTRACT_VERDICTS.has(exec.output_contract)
        ? (exec.output_contract as OutputContractVerdict)
        : "none",
  };
}

function topLevelSteps(dag: unknown): Array<{ id: string; kind: string }> {
  const steps = (dag as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((s) =>
    s && typeof s === "object" && typeof (s as { id?: unknown }).id === "string"
      ? [
          {
            id: (s as { id: string }).id,
            kind: String((s as { kind?: unknown }).kind ?? "unknown"),
          },
        ]
      : [],
  );
}

/** The outcome of one execution row: its step rows and its version's steps, two queries. */
export async function loadExecutionOutcome(
  tenantId: string,
  exec: Pick<ExecutionRow, "id" | "status" | "failure" | "output_contract" | "workflow_version_id">,
  db: Executor,
): Promise<ExecutionOutcome> {
  const [rows, version] = await Promise.all([
    db
      .select({
        step_key: executionSteps.step_key,
        kind: executionSteps.kind,
        status: executionSteps.status,
        error: executionSteps.error,
        held: executionSteps.held,
        request_meta: executionSteps.request_meta,
        started_at: executionSteps.started_at,
      })
      .from(executionSteps)
      .where(and(eq(executionSteps.tenant_id, tenantId), eq(executionSteps.execution_id, exec.id)))
      .orderBy(asc(executionSteps.started_at)),
    exec.workflow_version_id
      ? db
          .select({ dag: workflowVersions.dag })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.tenant_id, tenantId),
              eq(workflowVersions.id, exec.workflow_version_id),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  return deriveExecutionOutcome(exec, rows, topLevelSteps(version[0]?.dag));
}

/**
 * `failure` for a page of list rows: which step stopped each failed run and
 * its class. One query for the whole page; runs that did not fail are absent.
 */
export async function loadFailureSummaries(
  tenantId: string,
  execs: ReadonlyArray<Pick<ExecutionRow, "id" | "status" | "failure">>,
  db: Executor,
): Promise<Map<string, ExecutionFailureSummary>> {
  const out = new Map<string, ExecutionFailureSummary>();
  const failedRuns = execs.filter((e) => FAILED_RUN_STATUSES.has(e.status));
  if (failedRuns.length === 0) return out;
  const rows = await db
    .select({
      execution_id: executionSteps.execution_id,
      step_key: executionSteps.step_key,
      status: executionSteps.status,
      error: executionSteps.error,
      started_at: executionSteps.started_at,
    })
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, tenantId),
        inArray(
          executionSteps.execution_id,
          failedRuns.map((e) => e.id),
        ),
        inArray(executionSteps.status, [...FAILED_STEP_STATUSES]),
      ),
    )
    .orderBy(asc(executionSteps.started_at));
  const byExecution = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byExecution.get(row.execution_id) ?? [];
    list.push(row);
    byExecution.set(row.execution_id, list);
  }
  for (const exec of failedRuns) {
    const stopping = pickStoppingStep(byExecution.get(exec.id) ?? [], exec.failure?.step_id);
    const cause = classifyRunFailure(exec, stopping);
    out.set(exec.id, {
      step_key: stopping?.step_key ?? exec.failure?.step_id ?? null,
      cause_class: cause?.classification ?? null,
    });
  }
  return out;
}
