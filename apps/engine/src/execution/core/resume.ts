import type { ExecutionStatus, StepStatus } from "./status.ts";

export function baseStepKey(step_key: string): string {
  return step_key.replace(/(\[\d+\])+$/, "");
}

function iterationIndex(step_key: string): number {
  const match = /\[(\d+)\]$/.exec(step_key);
  return match ? Number(match[1]) : -1;
}

export interface ResumeStep {
  id: string;
  kind: string;
  for_each: boolean;
  secret_outputs: boolean;
  writes: boolean;
}

export interface ResumeRow {
  step_key: string;
  status: StepStatus;
  write_dispatched: boolean;
}

export interface ResumeFacts {
  status: ExecutionStatus;
  heartbeat_age_ms: number | null;
  lease_ms: number;
  sensitive: boolean;
  held: boolean;
  child: boolean;
  unsaved: boolean;
  direct: boolean;
  device: boolean;
  steps: readonly ResumeStep[];
  rows: readonly ResumeRow[];
}

export type NotResumableReason =
  | "not_running"
  | "sensitive"
  | "held"
  | "child"
  | "unsaved"
  | "direct"
  | "device_step"
  | "step_failed"
  | "unknown_step"
  | "secret_output"
  | "container_step";

export type ResumeDecision =
  | { kind: "alive" }
  | { kind: "fresh" }
  | { kind: "resume"; fixtures: string[]; completed_for_each: string[]; superseded: string[] }
  | { kind: "uncertain"; step_keys: string[] }
  | { kind: "not_resumable"; reason: NotResumableReason; interrupted_writes: string[] };

const UNREBUILDABLE_KINDS: ReadonlySet<string> = new Set(["loop", "parallel"]);
const FAILED_STEP_STATUSES: ReadonlySet<StepStatus> = new Set(["failed", "timed_out", "aborted"]);

export function interruptedWriteKeys(
  steps: readonly ResumeStep[],
  rows: readonly ResumeRow[],
): string[] {
  const stepsById = new Map(steps.map((step) => [step.id, step] as const));
  const declaredWrite = (step_key: string): boolean => {
    const base = baseStepKey(step_key);
    const step = stepsById.get(base);
    if (!step?.writes) return false;
    return !(step.for_each && step_key === base);
  };
  const keys = rows
    .filter(
      (row) =>
        row.status === "uncertain" ||
        (row.status === "running" && (row.write_dispatched || declaredWrite(row.step_key))),
    )
    .map((row) => row.step_key);
  return [...new Set(keys)];
}

function blocker(facts: ResumeFacts): NotResumableReason | null {
  if (facts.sensitive) return "sensitive";
  if (facts.held) return "held";
  if (facts.child) return "child";
  if (facts.unsaved) return "unsaved";
  if (facts.direct) return "direct";
  if (facts.device) return "device_step";
  return null;
}

export function resumeDecision(facts: ResumeFacts): ResumeDecision {
  if (facts.status !== "running" && facts.status !== "queued")
    return { kind: "not_resumable", reason: "not_running", interrupted_writes: [] };
  if (
    facts.status === "running" &&
    (facts.heartbeat_age_ms === null || facts.heartbeat_age_ms < facts.lease_ms)
  )
    return { kind: "alive" };

  const rows = facts.rows.filter((row) => row.status !== "skipped");
  const interrupted_writes = interruptedWriteKeys(facts.steps, rows);
  const blocked = blocker(facts);
  if (blocked && (facts.status === "running" || rows.length > 0))
    return { kind: "not_resumable", reason: blocked, interrupted_writes };
  if (rows.length === 0) return { kind: "fresh" };
  if (interrupted_writes.length > 0) return { kind: "uncertain", step_keys: interrupted_writes };

  const refuse = (reason: NotResumableReason): ResumeDecision => ({
    kind: "not_resumable",
    reason,
    interrupted_writes: [],
  });
  const stepsById = new Map(facts.steps.map((step) => [step.id, step] as const));
  const fixtures = new Set<string>();
  const completedForEach = new Set<string>();
  const superseded = new Set<string>();
  for (const row of rows) {
    if (FAILED_STEP_STATUSES.has(row.status)) return refuse("step_failed");
    const base = baseStepKey(row.step_key);
    const step = stepsById.get(base);
    if (!step) return refuse("unknown_step");
    if (UNREBUILDABLE_KINDS.has(step.kind)) return refuse("container_step");
    if (row.status !== "succeeded") {
      if (step.kind === "call") return refuse("container_step");
      superseded.add(row.step_key);
      continue;
    }
    if (step.secret_outputs) return refuse("secret_output");
    if (row.step_key === base && step.for_each) completedForEach.add(base);
    else fixtures.add(row.step_key);
  }
  return {
    kind: "resume",
    fixtures: [...fixtures],
    completed_for_each: [...completedForEach],
    superseded: [...superseded],
  };
}

interface RebuiltEnvelope {
  data: unknown;
  duration_ms: number;
  error: null;
}

export function assembleFixtures(
  envelopes: Readonly<Record<string, unknown>>,
  completed_for_each: readonly string[],
): Record<string, unknown> {
  const completed = new Set(completed_for_each);
  const fixtures: Record<string, unknown> = {};
  const iterations = new Map<string, string[]>();
  for (const [key, envelope] of Object.entries(envelopes)) {
    const base = baseStepKey(key);
    if (key === base || !completed.has(base)) {
      fixtures[key] = envelope;
      continue;
    }
    iterations.set(base, [...(iterations.get(base) ?? []), key]);
  }
  for (const id of completed) {
    const keys = (iterations.get(id) ?? []).sort((a, b) => iterationIndex(a) - iterationIndex(b));
    const rebuilt: RebuiltEnvelope = {
      data: keys.map((key) => ({ [id]: envelopes[key] })),
      duration_ms: 0,
      error: null,
    };
    fixtures[id] = rebuilt;
  }
  return fixtures;
}

export function storedStepOutput(preview: unknown): unknown {
  if (preview === null || typeof preview !== "object" || Array.isArray(preview)) return preview;
  const record = preview as Record<string, unknown>;
  const keys = Object.keys(record);
  const wrapped =
    keys.length === 2 &&
    "value" in record &&
    Array.isArray(record.warnings) &&
    record.warnings.length > 0;
  return wrapped ? record.value : preview;
}

export const ENGINE_STOPPED = "engine_crash_recovery";

export const ENGINE_STOPPED_MESSAGE =
  "The engine stopped during this run and the run cannot continue by itself. Start it again.";

export type WriteOutcome = "arrived" | "not_arrived";

export const WRITE_NOT_ARRIVED = "write_not_arrived";

interface ResolvedStepState {
  status: "succeeded" | "skipped";
  error: { code: string; message: string } | null;
}

export function resolvedStepState(outcome: WriteOutcome): ResolvedStepState {
  if (outcome === "arrived") return { status: "succeeded", error: null };
  return {
    status: "skipped",
    error: {
      code: WRITE_NOT_ARRIVED,
      message: "The change did not reach the target. The step is sent again.",
    },
  };
}

export type ResolveWriteVerdict = "not_uncertain" | "unknown_step" | "requeue" | "wait";

export function resolveWriteVerdict(facts: {
  status: ExecutionStatus;
  uncertain_step_keys: readonly string[];
  step_key: string;
}): ResolveWriteVerdict {
  if (facts.status !== "uncertain") return "not_uncertain";
  if (!facts.uncertain_step_keys.includes(facts.step_key)) return "unknown_step";
  return facts.uncertain_step_keys.every((key) => key === facts.step_key) ? "requeue" : "wait";
}
