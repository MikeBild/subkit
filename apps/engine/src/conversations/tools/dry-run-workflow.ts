// dry_run_workflow — run the draft workflow end-to-end via runExecution
// with source.kind="draft". No persistence of a workflow row is needed;
// the engine synthesizes workflow_id internally but keeps the executions
// row's workflow_id column NULL so it's clearly separable from saved runs.

import { z } from "@hono/zod-openapi";
import type { PreviewStepSummary } from "../../execution/classify.ts";
import { classifyRunResult } from "../../execution/classify.ts";
import { runExecution } from "../../execution/engine.ts";
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
    "Run the entire draft workflow via runExecution (source=draft). Produces an executions row with source_kind=draft, no workflow_id / workflow_version_id persisted.",
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
          error: "workflow draft has no runnable steps",
          reason: "empty_draft",
        },
      };
    }

    const definition = { name: draft.name ?? "draft", steps };
    const signal = ctx.abortSignal;
    let run: Awaited<ReturnType<typeof runExecution>>;
    try {
      run = await runExecution({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        source: {
          kind: "draft",
          definition,
          ...(draft.name ? { name: draft.name } : {}),
        },
        input: args.input ?? null,
        options: {
          request_source: "chat",
          execution_mode: args.environment ?? "dev",
          ...(signal ? { signal } : {}),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        data: {
          error: msg,
          reason: (err as { code?: string }).code ?? "draft_run_failed",
        },
      };
    }

    const lastStepSummary = run.steps[run.steps.length - 1];
    const stoppedStep = run.steps.find((s) => s.status !== "succeeded") ?? null;
    const stoppedId = stoppedStep?.step_key ?? null;

    const lastStep: PreviewStepSummary | undefined = lastStepSummary
      ? classifyRunResult(
          steps.find((s) => s.id === lastStepSummary.step_key) ?? steps[steps.length - 1]!,
          run,
        )
      : undefined;

    const stoppedForDraft = stoppedId ?? lastStep?.step_id ?? "(end)";
    await ctx.setDraft(
      withLatestPreview(ctx.getDraft(), {
        ok: run.status === "succeeded",
        step_id: stoppedForDraft,
        summary: lastStep?.summary ?? `Run completed with status ${run.status}.`,
        preview: lastStep?.output_preview ?? null,
      }),
    );

    return {
      ok: run.status === "succeeded",
      data: {
        steps_ran: run.steps.length,
        duration_ms: run.steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0),
        classification:
          lastStep?.classification ?? (run.status === "succeeded" ? "ok" : "driver_error"),
        stopped_at_step_id: stoppedId,
        summary:
          run.status === "succeeded"
            ? `Ran ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} with no errors.`
            : `Run stopped at step \`${stoppedForDraft}\`: ${lastStep?.summary ?? run.error?.message ?? "unknown error"}`,
        execution_id: run.execution_id,
        ...(lastStep
          ? {
              last_step: {
                step_id: lastStep.step_id,
                kind: lastStep.kind,
                classification: lastStep.classification,
                duration_ms: lastStep.duration_ms,
                ...(lastStep.output_preview !== undefined
                  ? { output_preview: lastStep.output_preview }
                  : {}),
                ...(lastStep.error ? { error: lastStep.error } : {}),
              },
            }
          : {}),
      },
    };
  },
};
