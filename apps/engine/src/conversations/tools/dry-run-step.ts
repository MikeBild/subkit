// dry_run_step — run a single draft step in isolation via the same driver
// pipeline a production workflow uses. Backed by `runSingleStep`, which
// wraps the step in a one-step WorkflowDef and calls `runExecution` with
// source.kind="step". Classification taxonomy is preserved so the chat
// surface can still render human-readable failure summaries.

import { z } from "@hono/zod-openapi";
import { classifyRunResult, isTransientRunResult } from "../../execution/classify.ts";
import { runSingleStep } from "../../execution/step-run.ts";
import { logger } from "../../logging/logger.ts";
import {
  recordExecutionDryRun,
  recordExecutionWarningsEmitted,
} from "../../observability/instrumentation.ts";
import { buildScopeAtStep } from "../../workflows/scope-shape.ts";
import type { StepDef } from "../../workflows/types.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
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
    execute_writes: z
      .boolean()
      .optional()
      .describe(
        "Legacy preference retained for compatibility. Draft previews always hold writes, even when true. For live writes, save and activate an immutable workflow version and use its bounded execution or prepared one-shot approval.",
      ),
  })
  .openapi("DryRunStepToolInput");

export const dryRunStepTool: ConversationTool = {
  name: "dry_run_step",
  description:
    "Run a single draft step in isolation through the real driver pipeline. Produces an auditable executions row (source_kind=step). Read steps execute for real; WRITE steps are always HELD and never dispatched, even with execute_writes:true. Live writes require an immutable saved workflow version and its bounded execution or prepared one-shot approval.",
  inputSchema,
  category: "draft_write" as const,
  authoring_resource: "workflow",
  requires_draft: true,
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
    // Bounded transient retry (authoring safety net). The request/graphql
    // drivers already retry most transients in-band; a single residual flap
    // (an upstream 5xx/429/connection blip that survives the driver's own
    // retries) still surfaces as a failed dry-run. Four such failures in a
    // row trip `error_code_repeat_block` and stall the whole authoring
    // session on a fault that has nothing to do with the draft. Re-running
    // the single step up to twice more (500ms then 1s backoff) clears that
    // flap without masking a deterministic failure: only transient
    // classifications retry; timeouts and auth/4xx/schema errors fall
    // through on the first attempt.
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
    // Author build-time permission warning (Stream 4) — non-blocking; warns
    // when this step writes a connector the author cannot write.
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
    // Build a one-entry step_traces slot mirroring dry_run_workflow's
    // shape so subsequent inspect_workflow_draft / suggest_jsonata_paths
    // calls have a per-step scope to read against. Single-step
    // dry-runs are how the LLM explores a request shape before
    // committing to a transform — without persisting scope_at_step
    // here, the next call would have to re-run the whole workflow
    // just to learn the same shape.
    const runStep = run.steps[0];
    const stepTraceEntry = runStep
      ? {
          step_id: runStep.step_key,
          kind: runStep.kind,
          status: runStep.status,
          // Fingerprint stamping: bind this evidence to the
          // exact step definition it was recorded against so later
          // mutations drop it only when THIS step changes.
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
          // Hold-writes preview: the materialized-but-never-dispatched
          // request IS the step's reviewable artifact — same trace shape
          // as dry_run_workflow's step_trace entries.
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

    // Probe-style recovery hints when the step actually failed at the
    // driver level. Only applies to request-like kinds (request /
    // call) where status/timeout makes sense; transforms / loops
    // surface their own typed errors via `summary.error`.
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
        // Single-step surface: the held marker rides the top-level
        // payload too — the LLM must see "resolved but NOT dispatched"
        // without digging into step_traces.
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

/** Sleep for `ms`, resolving early (without throwing) if `signal` aborts
 *  during the wait. Keeps the transient-retry backoff responsive to the
 *  conversation's abort signal — a cancelled authoring turn must not block
 *  on a pending backoff. */
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
