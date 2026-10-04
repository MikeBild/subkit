import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executionSteps, type executions, workflowVersions } from "../db/schema/index.ts";
import {
  type ReportDeliveryRefusal,
  reportRefusalReason,
} from "../workflows/report-delivery-boundary.ts";
import {
  classifyPersistedFailure,
  type PersistedFailureClass,
  type PreviewClassification,
} from "./classify.ts";
import type { OutputContractVerdict, RefusedConnector } from "./state.ts";

export type OutcomeKind = "succeeded" | "failed" | "held" | "partial" | "running";

export interface ExecutionOutcome {
  kind: OutcomeKind;
  failed_step: { step_key: string; kind: string } | null;
  cause_class: PreviewClassification | null;
  error_code: string | null;
  refusal_reason: ReportDeliveryRefusal | null;
  connector: RefusedConnector | null;
  steps: { total: number; succeeded: number; failed: number; held: number; skipped: number };
  output_contract: OutputContractVerdict;
}

export interface ExecutionFailureSummary {
  step_key: string | null;
  cause_class: PreviewClassification | null;
  refusal_reason: ReportDeliveryRefusal | null;
  connector: RefusedConnector | null;
}

type ExecutionRow = typeof executions.$inferSelect;
type OutcomeExecution = Pick<ExecutionRow, "status" | "failure" | "output_contract">;

export interface OutcomeStepRow {
  step_key: string;
  kind: string;
  status: string;
  error: unknown;
  held: boolean;
  request_meta?: unknown;
  started_at: Date | null;
}

function isHeldRow(row: OutcomeStepRow): boolean {
  if (row.held) return true;
  const meta = row.request_meta as { extras?: { held?: unknown } } | null | undefined;
  return meta?.extras?.held === true;
}

const FAILED_STEP_STATUSES = new Set(["failed", "timed_out", "aborted"]);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out", "aborted"]);
const OUTPUT_CONTRACT_VERDICTS = new Set<string>(["passed", "violated", "none"]);

function rowOfStep(stepKey: string, stepId: string): boolean {
  return stepKey === stepId || stepKey.startsWith(`${stepId}[`);
}

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

export function refusedConnector(failure: ExecutionRow["failure"]): RefusedConnector | null {
  const connector = failure?.connector;
  if (!connector || typeof connector.reason !== "string") return null;
  return {
    connector_id: typeof connector.connector_id === "string" ? connector.connector_id : null,
    reason: connector.reason,
  };
}

export function classifyRunFailure(
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
    refusal_reason: stopping ? reportRefusalReason(stopping.error) : null,
    connector: kind === "failed" ? refusedConnector(exec.failure) : null,
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
      refusal_reason: stopping ? reportRefusalReason(stopping.error) : null,
      connector: refusedConnector(exec.failure),
    });
  }
  return out;
}
