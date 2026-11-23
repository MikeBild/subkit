import { z } from "@hono/zod-openapi";
import { type CallStep, MODEL_STEP_DEFAULT_OUTPUT_TOKENS, type ModelStep } from "../types.ts";
import { MODEL_STEP_DATA_PLACEHOLDERS, modelStepPlaceholders } from "./model-step-checks.ts";
import type { PlaceholderKind } from "./placeholder-parser.ts";

export const MODEL_CALL_DATA_PATHS_MAX = 200;

export const ModelCallEffectSchema = z
  .object({
    step_id: z.string().min(1),
    call_path: z.array(z.string().min(1)).length(1).optional(),
    flow: z.literal("workflow_step"),
    effect: z.literal("read"),
    max_output_tokens: z.number().int().min(1),
    repeated: z
      .boolean()
      .describe(
        "True when the step runs once per item of a for_each, so the model is called once per item.",
      ),
    data_paths: z
      .array(z.string().min(1))
      .max(MODEL_CALL_DATA_PATHS_MAX)
      .describe("The run data the step sends to the model, by placeholder path; never values."),
  })
  .strict();
export type ModelCallEffect = z.infer<typeof ModelCallEffectSchema>;

export function modelCallOf(step: ModelStep): ModelCallEffect {
  const paths = modelStepPlaceholders(step)
    .filter((placeholder) => MODEL_STEP_DATA_PLACEHOLDERS.has(placeholder.kind as PlaceholderKind))
    .map((placeholder) => placeholder.path);
  return {
    step_id: step.id,
    flow: "workflow_step",
    effect: "read",
    max_output_tokens: step.max_output_tokens ?? MODEL_STEP_DEFAULT_OUTPUT_TOKENS,
    repeated: step.for_each !== undefined,
    data_paths: [...new Set(paths)].sort().slice(0, MODEL_CALL_DATA_PATHS_MAX),
  };
}

export function modelCallThrough(call: ModelCallEffect, via: CallStep): ModelCallEffect {
  return {
    ...call,
    call_path: [via.id],
    repeated: call.repeated || via.for_each !== undefined,
  };
}

const keyOf = (call: Pick<ModelCallEffect, "step_id" | "call_path">) =>
  JSON.stringify([call.call_path?.[0] ?? "", call.step_id]);

export function modelCallLabel(call: Pick<ModelCallEffect, "step_id" | "call_path">): string {
  return call.call_path ? `${call.call_path[0]}/${call.step_id}` : call.step_id;
}

export function sortModelCalls(calls: readonly ModelCallEffect[]): ModelCallEffect[] {
  return [...calls].sort((a, b) => Number(keyOf(a) > keyOf(b)) - Number(keyOf(a) < keyOf(b)));
}

export function modelCallWidened(next: ModelCallEffect, granted: ModelCallEffect): boolean {
  const known = new Set(granted.data_paths);
  return (
    next.max_output_tokens > granted.max_output_tokens ||
    (next.repeated && !granted.repeated) ||
    next.data_paths.some((path) => !known.has(path))
  );
}

export function modelCallMatch(
  calls: readonly ModelCallEffect[] | undefined,
  call: ModelCallEffect,
): ModelCallEffect | undefined {
  const key = keyOf(call);
  return calls?.find((candidate) => keyOf(candidate) === key);
}
