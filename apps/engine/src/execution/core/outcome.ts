export type OutcomeKind = "succeeded" | "failed" | "held" | "partial" | "running";

export interface RerunSafety {
  mode: "repeat_safe" | "prepare_only" | "unavailable";
  reason: string;
}

export interface RerunSafetyFacts {
  source_kind: string | null | undefined;
  definition_valid: boolean;
  requires_preparation: boolean;
}

export interface OutcomeStepRow {
  step_key: string;
  kind: string;
  status: string;
  error: unknown;
  held: boolean;
  request_meta?: unknown;
  started_at: Date | null;
}

export interface OutcomeExecution {
  status: string;
  failure: { step_id?: string | null } | null;
  output_contract: string | null;
  source_kind?: string | null;
}

export interface OutcomeDefinitionStep {
  id: string;
  kind: string;
}

export interface OutcomeFailureFacts<
  Classification extends string,
  Refusal extends string,
  Connector,
> {
  classification: Classification | null;
  error_code: string | null;
  refusal_reason: Refusal | null;
  connector: Connector | null;
}

export interface OutcomeFacts<Classification extends string, Refusal extends string, Connector> {
  definition_steps: readonly OutcomeDefinitionStep[];
  rerun_safety: RerunSafety;
  failure: OutcomeFailureFacts<Classification, Refusal, Connector>;
}

export interface ExecutionOutcome<
  Classification extends string,
  Refusal extends string,
  Connector,
> {
  kind: OutcomeKind;
  failed_step: { step_key: string; kind: string } | null;
  cause_class: Classification | null;
  error_code: string | null;
  refusal_reason: Refusal | null;
  connector: Connector | null;
  steps: { total: number; succeeded: number; failed: number; held: number; skipped: number };
  output_contract: "passed" | "violated" | "none";
  planned_steps?: number | null;
  rerun_safety: RerunSafety;
}

export const FAILED_STEP_STATUSES = ["failed", "timed_out", "aborted"] as const;
const FAILED_STEP_STATUS_SET = new Set<string>(FAILED_STEP_STATUSES);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out", "aborted"]);
const OUTPUT_CONTRACT_VERDICTS = new Set<string>(["passed", "violated", "none"]);

function rowOfStep(stepKey: string, stepId: string): boolean {
  return stepKey === stepId || stepKey.startsWith(`${stepId}[`);
}

function isHeldRow(row: OutcomeStepRow): boolean {
  if (row.held) return true;
  const meta = row.request_meta as { extras?: { held?: unknown } } | null | undefined;
  return meta?.extras?.held === true;
}

export function isFailedRunStatus(status: string): boolean {
  return FAILED_RUN_STATUSES.has(status);
}

export function pickStoppingStep<
  T extends Pick<OutcomeStepRow, "step_key" | "status" | "started_at">,
>(rows: readonly T[], failureStepId: string | null | undefined): T | null {
  const failed = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => FAILED_STEP_STATUS_SET.has(row.status))
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

export function deriveRerunSafety(facts: RerunSafetyFacts): RerunSafety {
  if (facts.source_kind !== "saved") {
    return { mode: "unavailable", reason: "only saved workflow executions can be rerun" };
  }
  if (!facts.definition_valid) {
    return {
      mode: "prepare_only",
      reason: "the persisted workflow definition is unavailable or invalid",
    };
  }
  if (facts.requires_preparation) {
    return {
      mode: "prepare_only",
      reason: "the workflow may repeat external effects and requires preparation",
    };
  }
  return {
    mode: "repeat_safe",
    reason: "the complete workflow definition contains only read or local operations",
  };
}

export function deriveExecutionOutcome<
  Classification extends string,
  Refusal extends string,
  Connector,
>(
  exec: OutcomeExecution,
  rows: readonly OutcomeStepRow[],
  facts: OutcomeFacts<Classification, Refusal, Connector>,
): ExecutionOutcome<Classification, Refusal, Connector> {
  const running = exec.status === "queued" || exec.status === "running";
  let succeeded = 0;
  let failed = 0;
  let held = 0;
  let skipped = 0;
  for (const row of rows) {
    if (isHeldRow(row)) held += 1;
    else if (FAILED_STEP_STATUS_SET.has(row.status)) failed += 1;
    else if (row.status === "skipped") skipped += 1;
    else if (row.status === "succeeded") succeeded += 1;
  }
  const unrun = running
    ? 0
    : facts.definition_steps.filter((step) => !rows.some((row) => rowOfStep(row.step_key, step.id)))
        .length;
  skipped += unrun;

  const kind: OutcomeKind = running
    ? "running"
    : FAILED_RUN_STATUSES.has(exec.status)
      ? "failed"
      : held > 0
        ? "held"
        : failed > 0
          ? "partial"
          : "succeeded";
  const reportsFailure = kind === "failed" || kind === "partial";
  const stopping = reportsFailure ? pickStoppingStep(rows, exec.failure?.step_id) : null;
  const namedStepId = kind === "failed" ? exec.failure?.step_id : null;

  return {
    kind,
    failed_step: stopping
      ? { step_key: stopping.step_key, kind: stopping.kind }
      : namedStepId
        ? {
            step_key: namedStepId,
            kind: facts.definition_steps.find((step) => step.id === namedStepId)?.kind ?? "unknown",
          }
        : null,
    cause_class: reportsFailure ? facts.failure.classification : null,
    error_code: reportsFailure ? facts.failure.error_code : null,
    refusal_reason: reportsFailure ? facts.failure.refusal_reason : null,
    connector: kind === "failed" ? facts.failure.connector : null,
    steps: { total: rows.length + unrun, succeeded, failed, held, skipped },
    output_contract: OUTPUT_CONTRACT_VERDICTS.has(exec.output_contract ?? "")
      ? (exec.output_contract as "passed" | "violated" | "none")
      : "none",
    rerun_safety: facts.rerun_safety,
  };
}

export function fixedPlannedSteps(steps: readonly OutcomeDefinitionStep[]): number | null {
  return steps.length > 0 &&
    steps.every((step) => step.kind === "request" || step.kind === "transform")
    ? steps.length
    : null;
}

export interface RefusedConnector {
  connector_id: string | null;
  reason: string;
}

export function refusedConnector(
  failure:
    | Readonly<{ connector?: Readonly<{ reason?: unknown; connector_id?: unknown }> | null }>
    | null
    | undefined,
): RefusedConnector | null {
  const connector = failure?.connector;
  if (!connector || typeof connector.reason !== "string") return null;
  return {
    connector_id: typeof connector.connector_id === "string" ? connector.connector_id : null,
    reason: connector.reason,
  };
}
