// dry_run_step — returns a preview of a step's output.
//
// v1 implementation: no sandbox. The loop can use this to confirm
// that a step "is at least shaped plausibly" before asking for
// approval. Actual one-step execution lands in a future phase.

import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    step_id: z.string().min(1),
    input: z.unknown().optional(),
  })
  .openapi("DryRunStepToolInput");

export const dryRunStepTool: ConversationTool = {
  name: "dry_run_step",
  description: "Preview the output of a single step without committing the workflow.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = ctx.getDraft();
    const step = draft.steps.find((s) => s.id === args.step_id);
    if (!step) {
      return { ok: false, data: { error: `unknown step id: ${args.step_id}` } };
    }
    return {
      ok: true,
      data: {
        step_id: args.step_id,
        preview: {
          kind: step.kind,
          note: "dry-run is a best-effort shape preview in P10",
          // Echo back any provided input so deterministic tests can
          // assert on it.
          echo: args.input ?? null,
        },
      },
    };
  },
};
