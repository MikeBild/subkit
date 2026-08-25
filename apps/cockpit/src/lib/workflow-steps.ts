import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

export type ExecutionStep = components["schemas"]["ExecutionStep"];

export interface WorkflowStepDefinition {
  id: string;
  kind: string;
  /** Connector slug when the step names one. */
  connector: string | null;
  /** Connector reference, resolved to a name before display — never rendered raw. */
  connectorId: string | null;
  detail: string | null;
  raw: Record<string, unknown>;
}

/** The connector a step uses, as a name. Returns null rather than an id. */
export function connectorNameOf(
  definition: WorkflowStepDefinition,
  namesById: ReadonlyMap<string, string>,
): string | null {
  if (definition.connector) return definition.connector;
  if (!definition.connectorId) return null;
  return namesById.get(definition.connectorId) ?? null;
}

export interface WorkflowStepView {
  definition: WorkflowStepDefinition;
  /** The same step in the most recent run, when it ran at all. */
  lastRun: ExecutionStep | null;
}

const STEP_KIND_KEYS: Record<string, TranslationKey> = {
  request: "workflow.kind.request",
  transform: "workflow.kind.transform",
  call: "workflow.kind.call",
  wait: "workflow.kind.wait",
  wait_for_event: "workflow.kind.waitForEvent",
  branch: "workflow.kind.branch",
  parallel: "workflow.kind.parallel",
  loop: "workflow.kind.loop",
  tool: "workflow.kind.tool",
};

/** Names an engine step kind for people; an unknown enum never leaks into UI. */
export function workflowStepKindKey(kind: string): TranslationKey {
  return STEP_KIND_KEYS[kind] ?? "workflow.stepType";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads the parts of a step a person needs to recognise it, without a schema per kind. */
export function readStepDefinition(step: unknown, index: number): WorkflowStepDefinition {
  const raw = (typeof step === "object" && step !== null ? step : {}) as Record<string, unknown>;
  return {
    id: text(raw.id) ?? `step-${index + 1}`,
    kind: text(raw.kind) ?? text(raw.type) ?? "",
    connector: text(raw.connector) ?? text(raw.connector_slug),
    connectorId: text(raw.connector_id),
    detail:
      text(raw.expression) ??
      text(raw.path) ??
      text(raw.url) ??
      text(raw.data_selector) ??
      text(raw.query),
    raw,
  };
}

/**
 * Joins the saved definition with the most recent run by step id — the
 * execution rows carry it as `step_key`. A step that never ran keeps a null
 * result rather than borrowing another step's.
 */
export function joinStepsWithLastRun(
  steps: readonly unknown[],
  runSteps: readonly ExecutionStep[],
): WorkflowStepView[] {
  const byKey = new Map<string, ExecutionStep>();
  for (const runStep of runSteps) {
    const existing = byKey.get(runStep.step_key);
    if (!existing || (runStep.step_index ?? 0) >= (existing.step_index ?? 0))
      byKey.set(runStep.step_key, runStep);
  }
  return steps.map((step, index) => {
    const definition = readStepDefinition(step, index);
    return { definition, lastRun: byKey.get(definition.id) ?? null };
  });
}

/** What a step's last run produced, preferring the structured value. */
export function stepResultPreview(step: ExecutionStep | null): string | null {
  if (!step) return null;
  const error = render(step.error);
  if (error) return error;
  return render(step.output_preview) ?? step.result_preview ?? null;
}

function render(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
