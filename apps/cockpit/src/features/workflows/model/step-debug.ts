import type { components } from "@cli-core/engine-api/openapi";

type Schemas = components["schemas"];
type ExecutionStep = Schemas["ExecutionStep"];

export const STEP_DEBUG_TIMEOUT_MS = 60_000;
export const STEP_DEBUG_POLL_MS = 1_000;

export type StepDebugInputMode = "last_run" | "own";

export type ScopeGapReason = "not_run" | "not_finished" | "held" | "too_large" | "no_output";

export interface ScopeGap {
  step: string;
  reason: ScopeGapReason;
}

export interface LastRunScope {
  scope: Record<string, unknown>;
  gaps: ScopeGap[];
}

function latestByKey(runSteps: readonly ExecutionStep[]): Map<string, ExecutionStep> {
  const byKey = new Map<string, ExecutionStep>();
  for (const runStep of runSteps) {
    const existing = byKey.get(runStep.step_key);
    if (!existing || (runStep.step_index ?? 0) >= (existing.step_index ?? 0))
      byKey.set(runStep.step_key, runStep);
  }
  return byKey;
}

function gapReason(step: ExecutionStep | undefined): ScopeGapReason | null {
  if (!step) return "not_run";
  if (step.held) return "held";
  if (step.status !== "succeeded") return "not_finished";
  if (step.result_storage_uri) return "too_large";
  if (step.output_preview === undefined || step.output_preview === null) return "no_output";
  return null;
}

export function scopeFromLastRun(
  stepIds: readonly string[],
  target: string,
  runSteps: readonly ExecutionStep[],
): LastRunScope {
  const at = stepIds.indexOf(target);
  const prior = at < 0 ? [] : stepIds.slice(0, at);
  const byKey = latestByKey(runSteps);
  const scope: Record<string, unknown> = {};
  const gaps: ScopeGap[] = [];
  for (const id of prior) {
    const step = byKey.get(id);
    const reason = gapReason(step);
    if (reason) {
      gaps.push({ step: id, reason });
      continue;
    }
    scope[id] = { data: step?.output_preview, duration_ms: step?.duration_ms ?? 0, error: null };
  }
  return { scope, gaps };
}

export type OwnScope =
  | { ok: true; scope: Record<string, unknown> }
  | { ok: false; reason: "not_json" | "not_object" };

export function parseOwnScope(text: string): OwnScope {
  if (text.trim() === "") return { ok: true, scope: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, reason: "not_object" };
  return { ok: true, scope: parsed as Record<string, unknown> };
}

export function ownScopeDraft(scope: Record<string, unknown>): string {
  return JSON.stringify(scope, null, 2);
}

export function stepDebugRequest(
  step: Schemas["ExecutionRunStep"],
  scope: Record<string, unknown>,
): Schemas["ExecutionRunStepBody"] {
  return {
    source: "step",
    hold_writes: true as const,
    step,
    ...(Object.keys(scope).length > 0 ? { scope } : {}),
    timeout_ms: STEP_DEBUG_TIMEOUT_MS,
  };
}

export type StepDebugPhase =
  | "idle"
  | "starting"
  | "waiting"
  | "running"
  | "succeeded"
  | "held"
  | "failed"
  | "stopped"
  | "uncertain"
  | "refused";

export interface StepDebugFacts {
  starting: boolean;
  refused: boolean;
  execution: { status: string } | null;
  step: Pick<ExecutionStep, "status" | "held"> | null;
}

export function stepDebugPhase(facts: StepDebugFacts): StepDebugPhase {
  if (facts.starting) return "starting";
  if (facts.refused) return "refused";
  if (!facts.execution) return "idle";
  switch (facts.execution.status) {
    case "queued":
    case "pending":
    case "waiting_budget":
    case "waiting_for_device":
      return "waiting";
    case "running":
      return "running";
    case "succeeded":
    case "completed":
      return facts.step?.held ? "held" : "succeeded";
    case "aborted":
    case "cancelled":
      return "stopped";
    case "uncertain":
      return "uncertain";
    default:
      return "failed";
  }
}

export function stepDebugActive(phase: StepDebugPhase): boolean {
  return phase === "starting" || phase === "waiting" || phase === "running";
}

export function stepDebugStoppable(phase: StepDebugPhase): boolean {
  return phase === "waiting" || phase === "running";
}

export type OutputSummary =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "list"; count: number }
  | { kind: "record"; fields: { name: string; value: string }[]; more: number };

const SUMMARY_FIELDS = 6;
const SUMMARY_TEXT = 160;

function shorten(value: string): string {
  return value.length > SUMMARY_TEXT ? `${value.slice(0, SUMMARY_TEXT)}…` : value;
}

function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return shorten(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return "{…}";
}

export function outputSummary(output: unknown): OutputSummary {
  if (output === null || output === undefined || output === "") return { kind: "empty" };
  if (Array.isArray(output)) return { kind: "list", count: output.length };
  if (typeof output === "object") {
    const entries = Object.entries(output as Record<string, unknown>);
    if (entries.length === 0) return { kind: "empty" };
    return {
      kind: "record",
      fields: entries
        .slice(0, SUMMARY_FIELDS)
        .map(([name, value]) => ({ name, value: fieldValue(value) })),
      more: Math.max(0, entries.length - SUMMARY_FIELDS),
    };
  }
  return { kind: "text", text: shorten(String(output)) };
}

export function debugStepRow<T extends { step_key: string; step_index: number | null }>(
  steps: readonly T[],
  stepId: string,
): T | null {
  return steps.find((step) => step.step_key === stepId) ?? steps[0] ?? null;
}

export function debugErrorText(error: unknown): string | null {
  if (error === null || error === undefined || error === "") return null;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message ? message : JSON.stringify(error);
}
