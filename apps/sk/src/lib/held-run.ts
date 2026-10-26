import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import { cockpitUrl, terminalText } from "./intake-review.ts";

type ExecutionOutcome = components["schemas"]["ExecutionOutcome"];

interface HeldRunSource {
  outcome?: ExecutionOutcome | null;
  hold_writes?: boolean;
  workflow_id?: string | null;
  workflow_name?: string | null;
  status?: string;
}

function stepIsHeld(step: Record<string, unknown>): boolean {
  if (step.held === true) return true;
  const meta = step.request_meta as { extras?: { held?: unknown } } | null | undefined;
  return meta?.extras?.held === true;
}

export function heldStepKeys(steps: readonly Record<string, unknown>[]): string[] {
  return steps
    .filter(stepIsHeld)
    .map((step) => (typeof step.step_key === "string" ? step.step_key : ""))
    .filter((key) => key.length > 0);
}

export function isHeldRun(source: HeldRunSource, steps: readonly Record<string, unknown>[] = []) {
  if (source.outcome) return source.outcome.kind === "held";
  return source.hold_writes === true && steps.some(stepIsHeld);
}

export function heldRunBlock(
  client: Pick<EngineClient, "base">,
  source: HeldRunSource,
  steps: readonly Record<string, unknown>[] = [],
): string | null {
  if (!isHeldRun(source, steps)) return null;
  const lines = [
    "Held: nothing was written.",
    "The run only prepared its work. No data was changed anywhere. Writes need an approval for this workflow.",
  ];
  const keys = heldStepKeys(steps);
  if (keys.length > 0) {
    lines.push(`Held steps: ${keys.map(terminalText).join(", ")}`);
  } else if (source.outcome && source.outcome.steps.held > 0) {
    lines.push(`Held steps: ${source.outcome.steps.held}`);
  }
  const name = source.workflow_name ? terminalText(source.workflow_name) : null;
  if (source.workflow_id) {
    const target = name ? `Approve “${name}” here` : "Approve here";
    lines.push(
      `${target}: ${cockpitUrl(client, `workflows/${encodeURIComponent(source.workflow_id)}`)}`,
    );
  }
  return lines.join("\n");
}

export async function heldRunBlockForExecution(
  client: Pick<EngineClient, "base" | "getExecution" | "executionSteps">,
  executionId: string,
): Promise<string | null> {
  try {
    const execution = (await client.getExecution(executionId)) as HeldRunSource;
    if (execution.outcome?.kind !== "held") return null;
    const { items } = await client.executionSteps(executionId);
    return heldRunBlock(client, execution, items);
  } catch {
    return null;
  }
}
