import { z } from "zod";
import type { EngineClient } from "../engine-client.ts";
import { terminalText } from "./intake-review.ts";

export const UNCERTAIN_STATUS = "uncertain";
export const UNCERTAIN_LABEL = "Outcome unknown";
export const UNCERTAIN_EVENT = "execution.uncertain";

export const WRITE_OUTCOMES = ["arrived", "not_arrived"] as const;

export const ResolveWriteBodySchema = z
  .object({ step_key: z.string().min(1), outcome: z.enum(WRITE_OUTCOMES) })
  .strict();
export type ResolveWriteBody = z.infer<typeof ResolveWriteBodySchema>;

export const ResolveWriteResponseSchema = z
  .object({ execution_id: z.string().optional(), status: z.string().optional() })
  .passthrough();
export type ResolveWriteResponse = z.infer<typeof ResolveWriteResponseSchema>;

export function statusText(status: string): string {
  return status === UNCERTAIN_STATUS ? `${UNCERTAIN_STATUS} (${UNCERTAIN_LABEL})` : status;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function eventKeys(value: unknown): string[] {
  const source = record(value);
  const many = source && Array.isArray(source.step_keys) ? source.step_keys : [];
  return many.filter((key): key is string => typeof key === "string" && key.length > 0);
}

function failureKeys(value: unknown): string[] {
  const stepId = record(value)?.step_id;
  return typeof stepId === "string" && stepId.length > 0 ? [stepId] : [];
}

export interface UncertainSource {
  status?: string;
  failure?: unknown;
  step_keys?: readonly string[];
}

export function uncertainStepKeys(
  source: UncertainSource,
  steps: readonly Record<string, unknown>[] = [],
): string[] {
  const marked = steps
    .filter((step) => step.status === UNCERTAIN_STATUS)
    .map((step) => (typeof step.step_key === "string" ? step.step_key : ""))
    .filter((key) => key.length > 0);
  if (source.step_keys && source.step_keys.length > 0) return [...new Set(source.step_keys)];
  return [...new Set([...failureKeys(source.failure), ...marked])];
}

export function uncertainWriteBlock(
  executionId: string,
  source: UncertainSource,
  steps: readonly Record<string, unknown>[] = [],
): string | null {
  if (source.status !== UNCERTAIN_STATUS) return null;
  const keys = uncertainStepKeys(source, steps);
  const lines = [
    `${UNCERTAIN_LABEL}: the run stopped while a change was being sent.`,
    "The change may or may not have reached its target. Nothing is sent again until you say which it was.",
  ];
  if (keys.length === 0) {
    lines.push(
      `Find the step with: subkit executions steps ${executionId}`,
      `Then run: subkit executions resolve-write ${executionId} --step <step_key> --outcome arrived|not_arrived`,
    );
    return lines.join("\n");
  }
  lines.push(
    `Uncertain ${keys.length === 1 ? "step" : "steps"}: ${keys.map(terminalText).join(", ")}`,
  );
  for (const key of keys) {
    const step = terminalText(key);
    lines.push(
      `If it arrived:        subkit executions resolve-write ${executionId} --step ${step} --outcome arrived`,
      `If it did not arrive: subkit executions resolve-write ${executionId} --step ${step} --outcome not_arrived`,
    );
  }
  return lines.join("\n");
}

export async function uncertainWriteBlockForExecution(
  client: Pick<EngineClient, "getExecution" | "executionSteps">,
  executionId: string,
  eventPayload: unknown = null,
): Promise<string> {
  const step_keys = eventKeys(eventPayload);
  try {
    const execution = record(await client.getExecution(executionId));
    const { items } = await client.executionSteps(executionId);
    const source: UncertainSource = {
      status: UNCERTAIN_STATUS,
      step_keys,
      failure: execution?.failure,
    };
    return uncertainWriteBlock(executionId, source, items) ?? "";
  } catch {
    return uncertainWriteBlock(executionId, { status: UNCERTAIN_STATUS, step_keys }) ?? "";
  }
}
