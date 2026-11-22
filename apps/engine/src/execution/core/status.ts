export const EXECUTION_STATUSES = [
  "queued",
  "waiting_for_device",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
] as const;

export const STEP_STATUSES = [...EXECUTION_STATUSES, "skipped"] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export type StepStatus = (typeof STEP_STATUSES)[number];

export const NON_TERMINAL_EXECUTION_STATUSES = [
  "queued",
  "waiting_for_device",
  "running",
] as const satisfies readonly ExecutionStatus[];

export type NonTerminalExecutionStatus = (typeof NON_TERMINAL_EXECUTION_STATUSES)[number];

export type TerminalExecutionStatus = Exclude<ExecutionStatus, NonTerminalExecutionStatus>;

export const TERMINAL_EXECUTION_STATUSES = [
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
] as const satisfies readonly TerminalExecutionStatus[];

export function isTerminalExecutionStatus(
  status: ExecutionStatus,
): status is TerminalExecutionStatus {
  return (TERMINAL_EXECUTION_STATUSES as readonly ExecutionStatus[]).includes(status);
}

export const BEFORE_START_EXECUTION_STATUSES = [
  "queued",
  "waiting_for_device",
] as const satisfies readonly NonTerminalExecutionStatus[];

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  if (from === "queued") return to !== "queued";
  if (from === "waiting_for_device") return to === "queued" || to === "failed" || to === "aborted";
  return from === "running" && isTerminalExecutionStatus(to);
}

export function transitionSources(
  to: ExecutionStatus,
  allowed: readonly ExecutionStatus[] = EXECUTION_STATUSES,
): ExecutionStatus[] {
  return allowed.filter((from) => canTransition(from, to));
}

export function failureStatusOf(status: StepStatus): TerminalExecutionStatus {
  if (status === "aborted") return "aborted";
  if (status === "timed_out") return "timed_out";
  return "failed";
}

interface CrashRecoveryCandidate {
  abort_requested: boolean;
  started_at_ms: number | null;
  workflow_timeout_ms: number | null;
}

interface CrashRecoveryPolicy {
  now_ms: number;
  default_timeout_ms: number;
  grace_multiplier: number;
  override_threshold_ms?: number | undefined;
}

interface CrashRecoveryOutcome {
  status: "aborted" | "timed_out";
  reason: "engine_crash_recovery_abort_requested" | "engine_crash_recovery";
  message: string;
  threshold_ms: number;
  age_ms: number | null;
}

export function crashRecoveryOutcome(
  row: CrashRecoveryCandidate,
  policy: CrashRecoveryPolicy,
): CrashRecoveryOutcome | null {
  const baseTimeout = row.workflow_timeout_ms ?? policy.default_timeout_ms;
  const threshold_ms = policy.override_threshold_ms ?? baseTimeout * policy.grace_multiplier;
  const age_ms = row.started_at_ms === null ? null : policy.now_ms - row.started_at_ms;
  if (row.abort_requested)
    return {
      status: "aborted",
      reason: "engine_crash_recovery_abort_requested",
      message: "execution abort recovered after worker restart",
      threshold_ms,
      age_ms,
    };
  if (age_ms === null || age_ms < threshold_ms) return null;
  return {
    status: "timed_out",
    reason: "engine_crash_recovery",
    message: "execution timeout recovered after worker restart",
    threshold_ms,
    age_ms,
  };
}

export const ENGINE_STOPPED_DURING_WRITE = "engine_stopped_during_write";

export const WRITE_OUTCOME_GUIDANCE =
  "Check in the target system whether the change arrived before you run it again.";

interface InterruptedWriteNotice {
  code: typeof ENGINE_STOPPED_DURING_WRITE;
  step_id: string;
  message: string;
  guidance: string;
}

export function interruptedWriteNotice(
  write_step_keys: readonly string[],
): InterruptedWriteNotice | null {
  const [first] = write_step_keys;
  if (first === undefined) return null;
  const named = write_step_keys.map((key) => `“${key}”`).join(", ");
  const subject = write_step_keys.length === 1 ? `step ${named} was` : `steps ${named} were`;
  return {
    code: ENGINE_STOPPED_DURING_WRITE,
    step_id: first,
    message: `The engine stopped while ${subject} sending a change. It may have reached the target.`,
    guidance: WRITE_OUTCOME_GUIDANCE,
  };
}

export type ExecutionOutcome =
  | { type: "completed" }
  | { type: "failed" }
  | { type: "aborted" }
  | { type: "timed_out" }
  | { type: "enqueue_failed" }
  | { type: "admission_failed"; refused: boolean }
  | { type: "device_unavailable" }
  | { type: "cancelled" };

type ExecutionOutcomeType = ExecutionOutcome["type"];

const OUTCOME_STATUS: Record<ExecutionOutcomeType, TerminalExecutionStatus> = {
  completed: "succeeded",
  failed: "failed",
  aborted: "aborted",
  timed_out: "timed_out",
  enqueue_failed: "failed",
  admission_failed: "failed",
  device_unavailable: "failed",
  cancelled: "aborted",
};

const BEFORE_START_OUTCOMES: ReadonlySet<ExecutionOutcomeType> = new Set([
  "enqueue_failed",
  "admission_failed",
  "device_unavailable",
  "cancelled",
]);

export interface OutcomeTransition {
  status: TerminalExecutionStatus;
  sources: ExecutionStatus[];
  refused: boolean;
  event_type: string;
}

export function outcomeTransition(outcome: ExecutionOutcome): OutcomeTransition {
  const status = OUTCOME_STATUS[outcome.type];
  const refused = outcome.type === "admission_failed" && outcome.refused;
  return {
    status,
    sources: transitionSources(
      status,
      BEFORE_START_OUTCOMES.has(outcome.type)
        ? BEFORE_START_EXECUTION_STATUSES
        : NON_TERMINAL_EXECUTION_STATUSES,
    ),
    refused,
    event_type: refused ? "execution.refused" : `execution.${status}`,
  };
}

export function settledOutcome(status: ExecutionStatus): ExecutionOutcome {
  if (status === "succeeded") return { type: "completed" };
  return { type: isTerminalExecutionStatus(status) ? status : "failed" };
}
