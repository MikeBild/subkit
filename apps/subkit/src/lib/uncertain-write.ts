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

function keysOf(value: unknown): string[] {
  const source = record(value);
  if (!source) return [];
  const many = Array.isArray(source.step_keys) ? source.step_keys : [];
  const keys = many.filter((key): key is string => typeof key === "string" && key.length > 0);
  if (keys.length > 0) return keys;
  for (const field of ["step_key", "step_id"]) {
    const one = source[field];
    if (typeof one === "string" && one.length > 0) return [one];
  }
  return [];
}

export interface UncertainSource {
  status?: string;
  error?: unknown;
}

export function uncertainStepKeys(
  source: UncertainSource,
  steps: readonly Record<string, unknown>[] = [],
): string[] {
  const named = keysOf(source.error);
  if (named.length > 0) return named;
  return steps
    .filter((step) => step.status === UNCERTAIN_STATUS || step.status === "running")
    .map((step) => (typeof step.step_key === "string" ? step.step_key : ""))
    .filter((key) => key.length > 0);
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
  const fromEvent = keysOf(eventPayload);
  try {
    const execution = (await client.getExecution(executionId)) as UncertainSource;
    const { items } = await client.executionSteps(executionId);
    const source: UncertainSource = {
      status: UNCERTAIN_STATUS,
      error: fromEvent.length > 0 ? { step_keys: fromEvent } : execution.error,
    };
    return uncertainWriteBlock(executionId, source, items) ?? "";
  } catch {
    return (
      uncertainWriteBlock(executionId, {
        status: UNCERTAIN_STATUS,
        error: { step_keys: fromEvent },
      }) ?? ""
    );
  }
}
