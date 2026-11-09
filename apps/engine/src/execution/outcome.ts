import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executionSteps, type executions, workflowVersions } from "../db/schema/index.ts";
import {
  type ReportDeliveryRefusal,
  reportRefusalReason,
} from "../workflows/report-delivery-boundary.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";
import { classifyRunFailure, type PreviewClassification } from "./core/classify.ts";

export { classifyRunFailure } from "./core/classify.ts";

import {
  type ExecutionOutcome as CoreExecutionOutcome,
  deriveExecutionOutcome as deriveCoreExecutionOutcome,
  deriveRerunSafety as deriveCoreRerunSafety,
  FAILED_STEP_STATUSES,
  fixedPlannedSteps,
  isFailedRunStatus,
  type OutcomeDefinitionStep,
  type OutcomeStepRow,
  pickStoppingStep,
  refusedConnector,
} from "./core/outcome.ts";
import type { RefusedConnector } from "./state.ts";
import { requestRequiresPreparationHold } from "./steps/request/side-effects.ts";

export type { OutcomeStepRow } from "./core/outcome.ts";
export type ExecutionOutcome = CoreExecutionOutcome<
  PreviewClassification,
  ReportDeliveryRefusal,
  RefusedConnector
>;

interface ExecutionFailureSummary {
  step_key: string | null;
  cause_class: PreviewClassification | null;
  refusal_reason: ReportDeliveryRefusal | null;
  connector: RefusedConnector | null;
}

type ExecutionRow = typeof executions.$inferSelect;
type OutcomeExecution = Pick<ExecutionRow, "status" | "failure" | "output_contract"> &
  Partial<Pick<ExecutionRow, "source_kind">>;

export { fixedPlannedSteps, pickStoppingStep, refusedConnector } from "./core/outcome.ts";

export function deriveExecutionOutcome(
  exec: OutcomeExecution,
  rows: readonly OutcomeStepRow[],
  definition: unknown = [],
): ExecutionOutcome {
  const definitionSteps = normalizedDefinitionSteps(definition);
  const stopping = pickStoppingStep(rows, exec.failure?.step_id);
  const cause = classifyRunFailure(exec, stopping);
  return deriveCoreExecutionOutcome(exec, rows, {
    definition_steps: definitionSteps,
    rerun_safety: deriveRerunSafety(exec.source_kind, definition),
    failure: {
      classification: cause?.classification ?? null,
      error_code: cause?.error_code ?? null,
      refusal_reason: stopping ? reportRefusalReason(stopping.error) : null,
      connector: refusedConnector(exec.failure),
    },
  });
}

export function deriveRerunSafety(
  sourceKind: ExecutionRow["source_kind"] | null | undefined,
  definition: unknown,
): ExecutionOutcome["rerun_safety"] {
  if (sourceKind !== "saved")
    return deriveCoreRerunSafety({
      source_kind: sourceKind,
      definition_valid: false,
      requires_preparation: false,
    });
  const parsed = WorkflowDefSchema.safeParse(definition);
  if (!parsed.success)
    return deriveCoreRerunSafety({
      source_kind: sourceKind,
      definition_valid: false,
      requires_preparation: false,
    });
  return deriveCoreRerunSafety({
    source_kind: sourceKind,
    definition_valid: true,
    requires_preparation: parsed.data.steps.some(
      (step) =>
        step.kind === "call" || (step.kind === "request" && requestRequiresPreparationHold(step)),
    ),
  });
}

function normalizedDefinitionSteps(definition: unknown): OutcomeDefinitionStep[] {
  const rawSteps = Array.isArray(definition) ? definition : topLevelSteps(definition);
  return rawSteps.filter(
    (step): step is OutcomeDefinitionStep =>
      Boolean(step) &&
      typeof step === "object" &&
      typeof (step as { id?: unknown }).id === "string" &&
      typeof (step as { kind?: unknown }).kind === "string",
  );
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
  exec: Pick<
    ExecutionRow,
    "id" | "status" | "failure" | "output_contract" | "workflow_version_id" | "source_kind"
  >,
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
  const definition = topLevelSteps(version[0]?.dag);
  return {
    ...deriveExecutionOutcome(exec, rows, version[0]?.dag ?? definition),
    planned_steps: fixedPlannedSteps(definition),
  };
}

export async function loadFailureSummaries(
  tenantId: string,
  execs: ReadonlyArray<Pick<ExecutionRow, "id" | "status" | "failure">>,
  db: Executor,
): Promise<Map<string, ExecutionFailureSummary>> {
  const out = new Map<string, ExecutionFailureSummary>();
  const failedRuns = execs.filter((e) => isFailedRunStatus(e.status));
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
