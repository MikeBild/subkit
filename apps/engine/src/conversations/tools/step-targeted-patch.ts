import { z } from "@hono/zod-openapi";
import type { ToolDiff } from "../json-patch-apply.ts";

const target = { step_id: z.string().min(1), path: z.string().regex(/^\/[^/]/) };
export const StepPatchSchema = z.discriminatedUnion("op", [
  z.object({ ...target, op: z.literal("add"), value: z.unknown() }).strict(),
  z.object({ ...target, op: z.literal("replace"), value: z.unknown() }).strict(),
  z.object({ ...target, op: z.literal("remove") }).strict(),
  z.object({ ...target, op: z.literal("test"), value: z.unknown() }).strict(),
]);

/** Resolve against the current draft, never an LLM-guessed list position. */
export function resolveStepPatches(
  steps: ReadonlyArray<Record<string, unknown>>,
  operations: ReadonlyArray<z.infer<typeof StepPatchSchema>>,
): ToolDiff[] {
  return operations.map((operation) => {
    const { step_id, ...patch } = StepPatchSchema.parse(operation);
    const matches = steps.flatMap((step, index) => (step.id === step_id ? [index] : []));
    if (matches.length !== 1)
      throw new Error(
        `Step '${step_id}' must identify exactly one current top-level step; found ${matches.length}. Inspect the current draft before retrying.`,
      );
    return { ...patch, path: `/steps/${matches[0]}${patch.path}` } as ToolDiff;
  });
}
