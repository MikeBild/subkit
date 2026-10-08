import { z } from "@hono/zod-openapi";
import { classifyRunResult, isTransientRunResult } from "../../execution/classify.ts";
import { runSingleStep } from "../../execution/step-run.ts";
import { logger } from "../../logging/logger.ts";
import {
  recordExecutionDryRun,
  recordExecutionWarningsEmitted,
} from "../../observability/instrumentation.ts";
import { validateTenantWorkflowDef } from "../../workflows/index.ts";
import { buildScopeAtStep } from "../../workflows/scope-shape.ts";
import type { StepDef } from "../../workflows/types.ts";
import { getWorkflowDraft, withLatestPreview } from "../authoring-state.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import { authorConnectorWriteWarnings } from "./author-build-warnings.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { resolveConversationPrincipal } from "./permission-gate.ts";
import { pickProbeRecoveryActions } from "./probe-recovery.ts";
import { truncateStepPreviewForLlm } from "./truncate.ts";

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
    "Run a single draft step in isolation through the real driver pipeline. Produces an auditable executions row (source_kind=step). Read steps execute for real; WRITE steps are always HELD and never dispatched. Live writes require an immutable saved workflow version and its bounded execution or prepared one-shot approval.",
  inputSchema,
  category: "draft_write" as const,
  authoring_resource: "workflow",
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const workflowDraft = getWorkflowDraft(ctx.getDraft());
    const validation = await validateTenantWorkflowDef(workflowDraft, ctx.tenant_id, ctx.db);
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
    const TRANSIENT_RETRY_BACKOFF_MS = [500, 1_000] as const;
    let run = await runSingleStep({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      step,
      hold_writes: true,
      input: args.input ?? null,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...(args.environment ? { environment: args.environment } : {}),
      ...(args.budget_ms !== undefined ? { timeout_ms: args.budget_ms } : {}),
      request_source: "chat",
    });
    for (
      let attempt = 0;
      attempt < TRANSIENT_RETRY_BACKOFF_MS.length &&
      isTransientRunResult(run) &&
      !ctx.abortSignal?.aborted;
      attempt++
    ) {
      const backoff_ms = TRANSIENT_RETRY_BACKOFF_MS[attempt]!;
      logger.warn({
        module: "conversation_tool",
        action: "dry_run_step.transient_retry",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        step_id: args.step_id,
        error_code: run.error?.code ?? null,
        attempt: attempt + 1,
        backoff_ms,
      });
      await sleepUnlessAborted(backoff_ms, ctx.abortSignal);
      if (ctx.abortSignal?.aborted) break;
      run = await runSingleStep({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        step,
        hold_writes: true,
        input: args.input ?? null,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        ...(args.environment ? { environment: args.environment } : {}),
        ...(args.budget_ms !== undefined ? { timeout_ms: args.budget_ms } : {}),
        request_source: "chat",
      });
    }
    const summary = classifyRunResult(step, run);
    const runWarnings = (run.warnings ?? []).map((w) => ({
      step_key: (w as { step_key?: string | null }).step_key ?? args.step_id,
      code: (w as { code?: string }).code ?? "unknown",
      message: (w as { message?: string }).message ?? "",
    }));
    const author = await resolveConversationPrincipal(ctx);
    if (author) {
      const authorWarnings = await authorConnectorWriteWarnings(ctx.db, author, ctx.tenant_id, [
        rawStep,
      ]);
      runWarnings.push(
        ...authorWarnings.map((w) => ({
          step_key: w.step_key ?? args.step_id,
          code: w.code,
          message: w.message,
        })),
      );
    }
    recordExecutionDryRun({ tenant_id: ctx.tenant_id, source_kind: "step" });
    if (runWarnings.length > 0) {
      recordExecutionWarningsEmitted({
        tenant_id: ctx.tenant_id,
        step_kind: summary.kind ?? "step",
        count: runWarnings.length,
      });
    }
    const runStep = run.steps[0];
    const stepTraceEntry = runStep
      ? {
          step_id: runStep.step_key,
          kind: runStep.kind,
          status: runStep.status,
          ...(runStep.step_key === args.step_id ? { fingerprint: stepFingerprint(rawStep) } : {}),
          ...(runStep.duration_ms != null ? { duration_ms: runStep.duration_ms } : {}),
          ...(runStep.output_preview !== undefined && runStep.output_preview !== null
            ? { output_preview: runStep.output_preview }
            : {}),
          ...(runStep.raw_preview !== undefined && runStep.raw_preview !== null
            ? { raw_preview: runStep.raw_preview }
            : {}),
          ...(runStep.output_preview !== undefined && runStep.output_preview !== null
            ? { scope_at_step: buildScopeAtStep(runStep.output_preview) }
            : {}),
          ...(runStep.error && typeof runStep.error === "object" && runStep.error !== null
            ? typeof (runStep.error as { code?: unknown }).code === "string"
              ? { error_code: (runStep.error as { code: string }).code }
              : {}
            : {}),
          ...(runStep.held
            ? { held: true, held_request: truncateStepPreviewForLlm(runStep.held_request).data }
            : {}),
        }
      : null;

    const nextDraft = withLatestPreview(
      ctx.getDraft(),
      {
        ok: summary.ok,
        step_id: summary.step_id,
        summary: summary.summary,
        preview: summary.output_preview ?? null,
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
        ...(stepTraceEntry ? { step_traces: [stepTraceEntry] } : {}),
        input: args.input ?? null,
      },
      "dry_run_step",
      "workflow_previewed",
    );
    await ctx.setDraft(nextDraft);

    const meta = (runStep?.request_meta ?? null) as {
      driver?: string;
      status?: number | null;
    } | null;
    const status = meta && typeof meta.status === "number" ? meta.status : 0;
    const errorCode = summary.error?.code ?? null;
    const failureCode =
      errorCode === "request_timeout" || errorCode === "probe_timeout" ? "request_timeout" : null;
    const isRequestFailure =
      (summary.ok === false &&
        (meta?.driver === "http" || meta?.driver === "graphql") &&
        status >= 400) ||
      failureCode !== null;
    const nextBestActions = isRequestFailure
      ? pickProbeRecoveryActions({
          ...(status > 0 ? { status } : {}),
          ...(failureCode ? { failure_code: failureCode } : {}),
        })
      : null;

    return {
      ok: summary.ok,
      data: buildLifecyclePayload(nextDraft, {
        step_id: summary.step_id,
        kind: summary.kind,
        duration_ms: summary.duration_ms,
        classification: summary.classification,
        summary: summary.summary,
        execution_id: run.execution_id,
        ...(runStep?.held
          ? { held: true, held_request: truncateStepPreviewForLlm(runStep.held_request).data }
          : {}),
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
        ...(summary.output_preview !== undefined ? { output_preview: summary.output_preview } : {}),
        ...(stepTraceEntry?.scope_at_step ? { scope_at_step: stepTraceEntry.scope_at_step } : {}),
        ...(stepTraceEntry?.raw_preview !== undefined
          ? { raw_preview: stepTraceEntry.raw_preview }
          : {}),
        ...(nextBestActions ? { next_best_actions: nextBestActions } : {}),
        ...(summary.error ? { error: summary.error } : {}),
      }),
    };
  },
};

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
