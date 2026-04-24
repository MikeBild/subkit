// dry_run_step — run a single draft step in isolation via the same driver
// pipeline a production workflow uses. Backed by `runSingleStep`, which
// wraps the step in a one-step WorkflowDef and calls `runExecution` with
// source.kind="step". Classification taxonomy is preserved so the chat
// surface can still render human-readable failure summaries.

import { z } from "@hono/zod-openapi";
import { classifyRunResult } from "../../execution/classify.ts";
import { runSingleStep } from "../../execution/step-run.ts";
import {
  recordExecutionDryRun,
  recordExecutionWarningsEmitted,
} from "../../observability/instrumentation.ts";
import type { StepDef } from "../../workflows/types.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withLatestPreview } from "../authoring-state.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
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
    "Run a single draft step in isolation through the real driver pipeline. Produces an executions row (source_kind=step) so the run is auditable and traceable.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const workflowDraft = getWorkflowDraft(ctx.getDraft());
    const validation = validateWorkflowDef(workflowDraft);
    if (!validation.ok) {
      const nextDraft = withLatestPreview(
        ctx.getDraft(),
        {
          ok: false,
          step_id: args.step_id,
          summary: "Preview blocked until the workflow draft validates cleanly.",
          preview: null,
        },
        "dry_run_step",
        "workflow_previewed",
      );
      await ctx.setDraft(nextDraft);
      return {
        ok: false,
        data: buildLifecyclePayload(nextDraft, {
          step_id: args.step_id,
          errors: validation.errors,
          steps: workflowDraft.steps.length,
          summary: "Preview blocked until the workflow draft validates cleanly.",
        }),
      };
    }
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
        data: { error: `step \`${args.step_id}\` has no kind and cannot be run` },
      };
    }
    const step = rawStep as unknown as StepDef;
    const run = await runSingleStep({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      step,
      input: args.input ?? null,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...(args.environment ? { environment: args.environment } : {}),
      ...(args.budget_ms !== undefined ? { timeout_ms: args.budget_ms } : {}),
      request_source: "chat",
    });
    const summary = classifyRunResult(step, run);
    const runWarnings = (run.warnings ?? []).map((w) => ({
      step_key: (w as { step_key?: string | null }).step_key ?? args.step_id,
      code: (w as { code?: string }).code ?? "unknown",
      message: (w as { message?: string }).message ?? "",
    }));
    recordExecutionDryRun({ tenant_id: ctx.tenant_id, source_kind: "step" });
    if (runWarnings.length > 0) {
      recordExecutionWarningsEmitted({
        tenant_id: ctx.tenant_id,
        step_kind: summary.kind ?? "step",
        count: runWarnings.length,
      });
    }
    const nextDraft = withLatestPreview(
      ctx.getDraft(),
      {
        ok: summary.ok,
        step_id: summary.step_id,
        summary: summary.summary,
        preview: summary.output_preview ?? null,
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
      },
      "dry_run_step",
      "workflow_previewed",
    );
    await ctx.setDraft(nextDraft);
    return {
      ok: summary.ok,
      data: buildLifecyclePayload(nextDraft, {
        step_id: summary.step_id,
        kind: summary.kind,
        duration_ms: summary.duration_ms,
        classification: summary.classification,
        summary: summary.summary,
        execution_id: run.execution_id,
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
        ...(summary.output_preview !== undefined ? { output_preview: summary.output_preview } : {}),
        ...(summary.error ? { error: summary.error } : {}),
      }),
    };
  },
};
