// dry_run_step — real scoped preview of a single draft step.
//
// Uses `previewStep` from the execution layer so the driver logic matches
// production, while bypassing step-runner persistence (no execution rows,
// no offload, no audit noise). Respects a wall-clock budget and is
// cancelable via the caller-supplied AbortSignal.

import { z } from "@hono/zod-openapi";
import { previewStep } from "../../execution/preview.ts";
import type { StepDef } from "../../workflows/types.ts";
import { getWorkflowDraft, withLatestPreview } from "../authoring-state.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    step_id: z.string().min(1),
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    budget_ms: z.number().int().min(500).max(60_000).optional(),
  })
  .openapi("DryRunStepToolInput");

export const dryRunStepTool: ConversationTool = {
  name: "dry_run_step",
  description:
    "Preview the output of a single draft step in a read-only sandbox. Runs the real driver but writes no execution rows.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const workflowDraft = getWorkflowDraft(ctx.getDraft());
    const rawStep = workflowDraft.steps.find(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as { id?: unknown }).id === args.step_id,
    );
    if (!rawStep) {
      return { ok: false, data: { error: `unknown step id: ${args.step_id}` } };
    }
    if (typeof rawStep.kind !== "string" || rawStep.kind.length === 0) {
      return {
        ok: false,
        data: { error: `step \`${args.step_id}\` has no kind and cannot be previewed` },
      };
    }
    const step = rawStep as unknown as StepDef;
    const summary = await previewStep({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      step,
      workflow_input: args.input ?? null,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...(args.environment ? { execution_mode: args.environment } : {}),
      ...(args.budget_ms !== undefined ? { budget_ms: args.budget_ms } : {}),
    });
    await ctx.setDraft(
      withLatestPreview(ctx.getDraft(), {
        ok: summary.ok,
        step_id: summary.step_id,
        summary: summary.summary,
        preview: summary.output_preview ?? null,
      }),
    );
    return {
      ok: summary.ok,
      data: {
        step_id: summary.step_id,
        kind: summary.kind,
        duration_ms: summary.duration_ms,
        classification: summary.classification,
        summary: summary.summary,
        ...(summary.output_preview !== undefined ? { output_preview: summary.output_preview } : {}),
        ...(summary.error ? { error: summary.error } : {}),
      },
    };
  },
};
