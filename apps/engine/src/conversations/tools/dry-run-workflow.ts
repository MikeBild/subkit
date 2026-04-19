// dry_run_workflow — preview the draft workflow end-to-end in a read-only
// sandbox. Walks steps in declaration order, feeds each step's output into
// the shared scope, and stops at the first failure with a classified error.
// Writes no execution rows and does not commit anything.

import { z } from "@hono/zod-openapi";
import { previewWorkflow } from "../../execution/preview.ts";
import type { StepDef } from "../../workflows/types.ts";
import { getWorkflowDraft, withLatestPreview } from "../authoring-state.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    budget_ms_per_step: z.number().int().min(500).max(60_000).optional(),
  })
  .openapi("DryRunWorkflowToolInput");

export const dryRunWorkflowTool: ConversationTool = {
  name: "dry_run_workflow",
  description:
    "Preview the entire draft workflow without committing it. Runs steps in order using the real drivers, stops at the first failure, writes no execution rows.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = getWorkflowDraft(ctx.getDraft());
    const steps = draft.steps.filter(
      (candidate): candidate is StepDef =>
        typeof candidate === "object" &&
        candidate !== null &&
        typeof (candidate as { kind?: unknown }).kind === "string",
    );
    if (steps.length === 0) {
      return {
        ok: false,
        data: {
          error: "workflow draft has no previewable steps",
          reason: "empty_draft",
        },
      };
    }
    const summary = await previewWorkflow({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      steps,
      workflow_input: args.input ?? null,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...(args.environment ? { execution_mode: args.environment } : {}),
      ...(args.budget_ms_per_step !== undefined
        ? { budget_ms_per_step: args.budget_ms_per_step }
        : {}),
    });
    const stoppedStepId = summary.stopped_at_step_id ?? summary.last_step?.step_id ?? "(end)";
    await ctx.setDraft(
      withLatestPreview(ctx.getDraft(), {
        ok: summary.ok,
        step_id: stoppedStepId,
        summary: summary.summary,
        preview: summary.last_step?.output_preview ?? null,
      }),
    );
    return {
      ok: summary.ok,
      data: {
        steps_ran: summary.steps_ran,
        duration_ms: summary.duration_ms,
        classification: summary.classification,
        stopped_at_step_id: summary.stopped_at_step_id,
        summary: summary.summary,
        ...(summary.last_step
          ? {
              last_step: {
                step_id: summary.last_step.step_id,
                kind: summary.last_step.kind,
                classification: summary.last_step.classification,
                duration_ms: summary.last_step.duration_ms,
                ...(summary.last_step.output_preview !== undefined
                  ? { output_preview: summary.last_step.output_preview }
                  : {}),
                ...(summary.last_step.error ? { error: summary.last_step.error } : {}),
              },
            }
          : {}),
      },
    };
  },
};
