// dry_run_workflow — run the draft workflow end-to-end via runExecution
// with source.kind="draft". No persistence of a workflow row is needed;
// the engine synthesizes workflow_id internally but keeps the executions
// row's workflow_id column NULL so it's clearly separable from saved runs.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { conversationToolCalls } from "../../db/schema/index.ts";
import type { PreviewStepSummary } from "../../execution/classify.ts";
import { classifyRunResult } from "../../execution/classify.ts";
import { runExecution } from "../../execution/engine.ts";
import { logger } from "../../logging/logger.ts";
import {
  recordExecutionDryRun,
  recordExecutionWarningsEmitted,
} from "../../observability/instrumentation.ts";
import type { StepDef } from "../../workflows/types.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withLatestPreview } from "../authoring-state.ts";
import { buildGateError, buildLifecyclePayload } from "./authoring-contract.ts";
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
    const validation = validateWorkflowDef(draft);
    if (!validation.ok) {
      const invalidStepId =
        typeof draft.steps[0]?.id === "string" ? draft.steps[0].id : "(invalid-draft)";
      const nextDraft = withLatestPreview(
        ctx.getDraft(),
        {
          ok: false,
          step_id: invalidStepId,
          summary: "Preview blocked until the workflow draft validates cleanly.",
          preview: null,
        },
        "dry_run_workflow",
        "workflow_previewed",
      );
      await ctx.setDraft(nextDraft);
      return {
        ok: false,
        data: buildLifecyclePayload(nextDraft, {
          name: draft.name,
          errors: validation.errors,
          steps: draft.steps.length,
          summary: "Preview blocked until the workflow draft validates cleanly.",
        }),
      };
    }
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

    // Circuit-breaker — same as run-workflow. Three consecutive
    // dry-runs producing `unresolved_identifier` warnings means the
    // LLM's strategy isn't converging. Halt and force the LLM to ask
    // or re-strategize instead of running again.
    try {
      const rows = await ctx.db
        .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, ctx.tenant_id),
            eq(conversationToolCalls.conversation_id, ctx.conversation_id),
          ),
        )
        .orderBy(desc(conversationToolCalls.created_at))
        .limit(8);
      let unresolved = 0;
      for (const r of rows) {
        if (r.tool !== "dry_run_workflow" && r.tool !== "run_workflow") continue;
        const data = r.output as { data?: { warnings?: Array<{ code?: unknown }> } } | null;
        const ws = data?.data?.warnings;
        if (!Array.isArray(ws)) continue;
        for (const w of ws) {
          if (w && typeof w.code === "string" && w.code === "unresolved_identifier") unresolved++;
        }
      }
      if (unresolved >= 3) {
        logger.warn({
          module: "conversation_tool",
          action: "dry_run_workflow.repair_loop_detected",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          unresolved_count: unresolved,
        });
        return {
          ok: false,
          data: buildGateError(ctx.getDraft(), {
            error_code: "repair_loop_detected",
            message:
              "stop — three previews in a row produced the same `unresolved_identifier` warning. Re-reading the data-handling skill, asking the user for a clarification, or proposing a structurally different draft is the right move. Another preview will produce the same warning.",
            recommended_mode: "workflow",
            next_best_actions: ["ask_user_text", "load_skill", "search_knowledge", "propose_step"],
          }),
        };
      }
    } catch {
      // DB blip: don't trip the breaker on a query failure.
    }

    const definition = { name: draft.name ?? "draft", steps };
    const signal = ctx.abortSignal;
    ctx.onLog?.(
      "info",
      `dry-running ${steps.length} step${steps.length === 1 ? "" : "s"} (env=${args.environment ?? "dev"})`,
    );
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

    // Per-step progress feed — same as run_workflow. Lets the user see
    // each step's status, kind, and duration in real time instead of a
    // single end-of-preview badge.
    for (const step of run.steps) {
      const errMsg =
        step.error && typeof step.error === "object" && step.error !== null
          ? (step.error as { message?: unknown }).message
          : null;
      const level: "info" | "warn" | "error" =
        step.status === "succeeded"
          ? "info"
          : step.status === "failed" || step.status === "timed_out"
            ? "error"
            : "warn";
      ctx.onLog?.(
        level,
        `step ${step.step_key} (${step.kind}) ${step.status}${
          step.duration_ms != null ? ` · ${step.duration_ms}ms` : ""
        }${typeof errMsg === "string" ? ` · ${errMsg}` : ""}`,
      );
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
    const runWarnings = (run.warnings ?? []).map((w) => ({
      step_key: (w as { step_key?: string | null }).step_key ?? null,
      code: (w as { code?: string }).code ?? "unknown",
      message: (w as { message?: string }).message ?? "",
    }));
    recordExecutionDryRun({ tenant_id: ctx.tenant_id, source_kind: "workflow" });
    if (runWarnings.length > 0) {
      recordExecutionWarningsEmitted({
        tenant_id: ctx.tenant_id,
        step_kind: "workflow",
        count: runWarnings.length,
      });
    }
    const nextDraft = withLatestPreview(
      ctx.getDraft(),
      {
        ok: run.status === "succeeded",
        step_id: stoppedForDraft,
        summary: lastStep?.summary ?? `Run completed with status ${run.status}.`,
        preview: lastStep?.output_preview ?? null,
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
      },
      "dry_run_workflow",
      "workflow_previewed",
    );
    await ctx.setDraft(nextDraft);

    return {
      ok: run.status === "succeeded",
      data: buildLifecyclePayload(nextDraft, {
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
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
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
      }),
    };
  },
};
