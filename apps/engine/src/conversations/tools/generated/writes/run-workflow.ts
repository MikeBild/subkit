// run_workflow tool — executes a workflow synchronously in the tenant's
// dev environment (unless the caller opts into prod). Writes an audit
// entry on each attempt.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import {
  conversations,
  conversationToolCalls,
  workflowVersions,
} from "../../../../db/schema/index.ts";
import { runExecution } from "../../../../execution/engine.ts";
import { logger } from "../../../../logging/logger.ts";
import { recordAuthoringGateBlock } from "../../../../observability/instrumentation.ts";
import { buildScopeAtStep } from "../../../../workflows/scope-shape.ts";
import {
  bindPersistedWorkflow,
  withLatestPreview,
  withWorkflowExecution,
} from "../../../authoring-state.ts";
import { buildGateError, buildLifecyclePayload } from "../../authoring-contract.ts";
import type { ConversationTool } from "../../index.ts";
import { truncateStepPreviewForLlm } from "../../truncate.ts";

/**
 * Codes that count toward the repair-loop circuit breaker. Each one
 * means "the JSONata path or template doesn't actually resolve to
 * data the engine can use" — so a re-run with the same draft will
 * produce the same warning. Three of any of these codes in the
 * recent history (per-code, not summed) trips the breaker.
 */
const REPEATING_REPAIR_CODES = new Set([
  "unresolved_identifier",
  "loop_over_unresolved",
  "transform_empty_extraction",
]);

/**
 * Circuit-breaker for repair loops. Walks the recent tool-call
 * history for this conversation and counts how many `run_workflow` /
 * `dry_run_workflow` invocations produced an authoring-bug warning
 * (see `REPEATING_REPAIR_CODES`). Three identical occurrences in a
 * row signal "the LLM is stuck rewriting the same JSONata five
 * different ways and every attempt produces the same warning" —
 * exactly the v3→v4→v5 spiral the user reported. We refuse and
 * surface a structured halt instead of letting the LLM burn another
 * 88k tokens.
 */
async function detectRepairLoop(
  db: ReturnType<typeof eq> extends never ? never : import("../../../../db/client.ts").Db,
  tenant_id: string,
  conversation_id: string,
): Promise<{
  tripped: boolean;
  recent_codes: string[];
  tripped_codes: Array<{ code: string; count: number }>;
}> {
  try {
    const rows = await db
      .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, tenant_id),
          eq(conversationToolCalls.conversation_id, conversation_id),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(8);
    const codes: string[] = [];
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (r.tool !== "run_workflow" && r.tool !== "dry_run_workflow") continue;
      const data = r.output as { data?: { warnings?: Array<{ code?: unknown }> } } | null;
      const ws = data?.data?.warnings;
      if (!Array.isArray(ws)) continue;
      for (const w of ws) {
        if (w && typeof w.code === "string") {
          codes.push(w.code);
          if (REPEATING_REPAIR_CODES.has(w.code)) {
            counts.set(w.code, (counts.get(w.code) ?? 0) + 1);
          }
        }
      }
    }
    const tripped_codes = [...counts.entries()]
      .filter(([, n]) => n >= 3)
      .map(([code, n]) => ({ code, count: n }));
    return {
      tripped: tripped_codes.length > 0,
      recent_codes: codes.slice(0, 8),
      tripped_codes,
    };
  } catch {
    return { tripped: false, recent_codes: [], tripped_codes: [] };
  }
}

const Input = z
  .object({
    workflow_id: z.string().uuid().optional(),
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    /**
     * When true, the result envelope always includes a `step_trace`
     * array (one entry per step: status, kind, duration_ms,
     * request_meta, output_preview, error_code). Mirrors the reference
     * impl's `includeStepResults: true`. Default behaviour still
     * attaches the trace on failure / partial / warnings, so leaving
     * this off costs nothing on the happy path.
     */
    include_step_trace: z.boolean().optional(),
  })
  .openapi("RunWorkflowToolInput");

/**
 * Terminal status the CLI must always see for a `run_workflow` result.
 * Missing this field is what produced the "Execution status missing
 * from engine — bug, not a state" UI in session 79bf2cca; the gate
 * error returns went through `buildGateError` which has no status
 * field. We close the contract here at the tool boundary instead of
 * trusting every callsite.
 */
type RunWorkflowStatus = "succeeded" | "failed" | "partial_success";

function withStatus(
  data: Record<string, unknown>,
  status: RunWorkflowStatus,
): Record<string, unknown> {
  // If a caller already set a more specific status (e.g. the lifecycle
  // path passes "succeeded"/"partial_success" via buildLifecyclePayload's
  // extra), keep it. Otherwise stamp the supplied default.
  if (typeof data.status === "string") return data;
  return { ...data, status };
}

export const runWorkflowTool: ConversationTool = {
  name: "run_workflow",
  description:
    "Execute a workflow synchronously by id. Records an audit entry. Default environment is `dev`.",
  inputSchema: Input,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const activeTarget = currentDraft.summary?.active_target ?? null;
    const workflowId =
      args.workflow_id ??
      (activeTarget?.kind === "workflow" && activeTarget.lifecycle_state === "persisted"
        ? activeTarget.id
        : null);
    if (!workflowId) {
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "workflow_not_persisted",
            message: "commit the workflow before running it from the conversation surface",
            recommended_mode: "workflow",
            stale_checkpoints: ["workflow_persisted"],
          }),
          "failed",
        ),
      };
    }
    const wf = await ctx.engineClient.workflows.get(workflowId);
    if (!wf) return { ok: false, data: withStatus({ error: "workflow_not_found" }, "failed") };
    if (
      activeTarget?.kind === "workflow" &&
      activeTarget.lifecycle_state === "draft_only" &&
      !args.workflow_id
    ) {
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "workflow_not_persisted",
            message: "commit the current workflow draft before running it",
            recommended_mode: "workflow",
            stale_checkpoints: ["workflow_persisted"],
          }),
          "failed",
        ),
      };
    }

    // Circuit-breaker: refuse to run when any repeating authoring-bug
    // warning code has fired three times in this conversation. The
    // LLM is chasing a fix that isn't working; another run won't
    // tell it anything new and burns tokens. Tracked codes:
    // unresolved_identifier, loop_over_unresolved,
    // transform_empty_extraction.
    const breaker = await detectRepairLoop(ctx.db, ctx.tenant_id, ctx.conversation_id);
    if (breaker.tripped) {
      logger.warn({
        module: "conversation_tool",
        action: "run_workflow.repair_loop_detected",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        recent_codes: breaker.recent_codes,
        tripped_codes: breaker.tripped_codes,
      });
      recordAuthoringGateBlock({ code: "repair_loop_detected", tool: "run_workflow" });
      const codesPretty = breaker.tripped_codes.map((c) => `\`${c.code}\` × ${c.count}`).join(", ");
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "repair_loop_detected",
            message: `stop — three or more consecutive runs of this workflow surfaced the same authoring-bug warning(s): ${codesPretty}. The current strategy is not working. Read \`data-handling.md\` and \`workflow-authoring.md\` for the loop+JSONata scope rules, ask the user what output they actually want, and propose a structurally different draft. Re-running this one will produce the same warning.`,
            recommended_mode: "diagnosis",
            next_best_actions: [
              "ask_user_text",
              "diagnose_latest_execution",
              "inspect_workflow_draft",
              "load_skill",
              "search_knowledge",
            ],
            extra: {
              recent_warning_codes: breaker.recent_codes,
              tripped_codes: breaker.tripped_codes,
            },
          }),
          "failed",
        ),
      };
    }

    try {
      ctx.onLog?.(
        "info",
        `running workflow ${wf.slug} (v${wf.current_version}) in env=${args.environment}`,
      );
      const result = await runExecution({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        source: { kind: "saved", workflow_id: workflowId },
        input: args.input ?? null,
        options: {
          request_source: "chat",
          trace_id: null,
          principal: null,
          execution_mode: args.environment,
        },
      });
      // Emit per-step progress logs so the user sees what each step
      // did during the run (status, kind, duration). Without this the
      // chat shows a single "Execution complete" badge and the loop's
      // empty body is invisible.
      for (const step of result.steps) {
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
      for (const w of result.warnings ?? []) {
        ctx.onLog?.(
          "warn",
          `step ${w.step_key} · ${w.code}${w.identifier ? ` · ${w.identifier}` : ""} · ${w.message}`,
        );
      }
      await ctx.engineClient.audit_write({
        resource_type: "execution",
        resource_id: result.execution_id,
        action: "conversation.run_workflow",
        result: result.status === "succeeded" ? "success" : "error",
        metadata: {
          conversation_id: ctx.conversation_id,
          workflow_id: workflowId,
          environment: args.environment,
          final_status: result.status,
        },
      });
      await ctx.db
        .update(conversations)
        .set({
          target_workflow_id: workflowId,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(conversations.tenant_id, ctx.tenant_id),
            eq(conversations.id, ctx.conversation_id),
          ),
        );
      // Surface non-fatal warnings (unresolved identifiers in transform
      // expressions, schema drift signals) so the LLM / operator sees
      // them next to the output. The execution may be technically
      // "succeeded" (no driver errors) but produced suspicious output:
      // - unresolved_identifier warnings → JSONata referenced names not
      //   in scope; output likely partial/null
      // - the workflow returned an empty array as top-level output
      //   from a step that fanned out (loop) → loop body never iterated
      // Both cases get tagged `partial_success` on the payload so the
      // CLI surfaces the warning treatment and the LLM is forced to
      // either repair or explicitly acknowledge the warning.
      const hasWarnings = (result.warnings?.length ?? 0) > 0;
      const hasUnresolvedIdentifierWarning = (result.warnings ?? []).some(
        (w) => w.code === "unresolved_identifier",
      );
      const hasTransformEmptyExtractionWarning = (result.warnings ?? []).some(
        (w) => w.code === "transform_empty_extraction",
      );
      const _hasTransformDroppedFieldsWarning = (result.warnings ?? []).some(
        (w) => w.code === "transform_dropped_fields",
      );
      const hasLoopOverUnresolvedWarning = (result.warnings ?? []).some(
        (w) => w.code === "loop_over_unresolved",
      );
      // The engine emits `loop_body_empty` from inside the loop driver
      // when iterations > 0 produced no productive body output (P2).
      // Trust that warning over the legacy "top-level output is []"
      // heuristic — the user's transcript had a populated top-level
      // output assembled by a transform AFTER the empty loop body, so
      // the legacy heuristic missed it.
      const hasLoopBodyEmptyWarning = (result.warnings ?? []).some(
        (w) => w.code === "loop_body_empty",
      );
      const loopStepRanWithEmptyBody =
        hasLoopBodyEmptyWarning ||
        (result.steps.some((s) => s.kind === "loop" && s.status === "succeeded") &&
          Array.isArray(result.output) &&
          (result.output as unknown[]).length === 0);
      // Partial-success: the run finished but signals that the LLM
      // should look at the warnings before treating the output as
      // final. `transform_dropped_fields` is informational (intentional
      // projections legitimately narrow fields) and therefore does NOT
      // tip the run into partial_success on its own — surfacing the
      // warning is enough; blocking the commit gate would force the
      // LLM into the patch loop the skill explicitly forbids.
      const isPartialSuccess =
        result.status === "succeeded" &&
        (hasUnresolvedIdentifierWarning ||
          loopStepRanWithEmptyBody ||
          hasTransformEmptyExtractionWarning ||
          hasLoopOverUnresolvedWarning);
      const payloadStatus = isPartialSuccess ? "partial_success" : result.status;
      // requires_repair gates the auto-persist commit. Mirrors the
      // skill: only the warnings that ALWAYS indicate a real bug
      // (unresolved identifier, empty extraction, loop body never ran)
      // tip the flag. transform_dropped_fields is omitted on purpose —
      // the warning still fires, but commit is not blocked.
      const requiresRepair =
        hasUnresolvedIdentifierWarning ||
        hasTransformEmptyExtractionWarning ||
        hasLoopOverUnresolvedWarning ||
        isPartialSuccess;
      const diagnosisAvailable = hasWarnings || result.status !== "succeeded" || isPartialSuccess;
      // Per-step trace — same envelope shape dry_run_workflow returns
      // so the LLM can pinpoint the failing step + see its driver
      // metadata (status code, byte counts, connector resolution) in
      // one read. Mirrors the reference impl's `run_tool({
      // includeStepResults: true })`. Always populated when the run
      // didn't succeed cleanly; omitted on success to save tokens
      // (the user can still inspect_workflow if they want details).
      const stepTraceEntries = result.steps.map((s) => {
        const errorCode =
          s.error && typeof s.error === "object" && s.error !== null
            ? (s.error as { code?: unknown }).code
            : undefined;
        const scope =
          s.output_preview !== undefined && s.output_preview !== null
            ? buildScopeAtStep(s.output_preview)
            : null;
        // Per-step LLM-context cap. The persisted step row (consumed
        // by inspect_execution_step / diagnose_latest_execution) keeps
        // the full preview; only the LLM-facing envelope is clipped,
        // because the offload threshold (10 KB) is bigger than the
        // outer LLM cap (8 KB) and a single inline preview can otherwise
        // dominate the envelope and force the outer truncate pass to
        // replace the workflow's `output` field with a marker.
        const previewForLlm =
          s.output_preview !== undefined && s.output_preview !== null
            ? truncateStepPreviewForLlm(s.output_preview)
            : null;
        const rawForLlm =
          s.raw_preview !== undefined && s.raw_preview !== null
            ? truncateStepPreviewForLlm(s.raw_preview)
            : null;
        return {
          step_id: s.step_key,
          kind: s.kind,
          status: s.status,
          ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
          ...(s.request_meta !== undefined && s.request_meta !== null
            ? { request_meta: s.request_meta }
            : {}),
          ...(previewForLlm
            ? {
                output_preview: previewForLlm.data,
                ...(previewForLlm.raw_ref ? { output_preview_ref: previewForLlm.raw_ref } : {}),
              }
            : {}),
          ...(rawForLlm
            ? {
                raw_preview: rawForLlm.data,
                ...(rawForLlm.raw_ref ? { raw_preview_ref: rawForLlm.raw_ref } : {}),
              }
            : {}),
          ...(scope ? { scope_at_step: scope } : {}),
          ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
          ...(s.error ? { error: s.error } : {}),
        };
      });
      const includeStepTrace =
        args.include_step_trace === true ||
        result.status !== "succeeded" ||
        isPartialSuccess ||
        hasWarnings;
      // Persist a compact per-step preview slot so subsequent
      // inspect_workflow / suggest_jsonata_paths / context-assembler
      // calls see the most recent shape per step. Mirrors what
      // dry_run_workflow does — the LLM reads from a single canonical
      // location regardless of whether the last walk was a dry-run
      // or a full run.
      const persistedStepTraces = result.steps.map((s) => {
        const errorCode =
          s.error && typeof s.error === "object" && s.error !== null
            ? (s.error as { code?: unknown }).code
            : undefined;
        const scope =
          s.output_preview !== undefined && s.output_preview !== null
            ? buildScopeAtStep(s.output_preview)
            : undefined;
        return {
          step_id: s.step_key,
          kind: s.kind,
          status: s.status,
          ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
          ...(s.output_preview !== undefined && s.output_preview !== null
            ? { output_preview: s.output_preview }
            : {}),
          ...(s.raw_preview !== undefined && s.raw_preview !== null
            ? { raw_preview: s.raw_preview }
            : {}),
          ...(scope ? { scope_at_step: scope } : {}),
          ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
        };
      });
      const previewedDraft = withLatestPreview(
        currentDraft,
        {
          ok: result.status === "succeeded",
          step_id:
            result.steps.find((s) => s.status !== "succeeded")?.step_key ??
            result.steps[result.steps.length - 1]?.step_key ??
            "(end)",
          summary: `run_workflow finished with status ${result.status}`,
          ...(hasWarnings && result.warnings ? { warnings: result.warnings } : {}),
          ...(requiresRepair ? { requires_repair: true } : {}),
          step_traces: persistedStepTraces,
          input: args.input ?? null,
        },
        "run_workflow",
        "workflow_executed",
      );
      // Propagate the per-step scope vocabulary to the persisted
      // workflow_versions row. The commit path writes scope_index at
      // commit time, but a successful production run reveals new
      // shapes (especially after schema drift) — refreshing the
      // persisted vocabulary on every successful run keeps
      // suggest_jsonata_paths and inspect_workflow accurate without
      // requiring a re-commit. Only writes on full success to avoid
      // poisoning the persisted shape with partial / aborted runs.
      if (result.status === "succeeded" && !isPartialSuccess && wf.current_version_id) {
        const persistedScopeIndex: Record<
          string,
          { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
        > = {};
        for (const trace of persistedStepTraces) {
          if (trace.scope_at_step) {
            persistedScopeIndex[trace.step_id] = {
              available_paths: trace.scope_at_step.available_paths,
              shape_summary: trace.scope_at_step.shape_summary,
              primary_data_path: trace.scope_at_step.primary_data_path ?? null,
            };
          }
        }
        if (Object.keys(persistedScopeIndex).length > 0) {
          try {
            await ctx.db
              .update(workflowVersions)
              .set({ scope_index: persistedScopeIndex })
              .where(
                and(
                  eq(workflowVersions.tenant_id, ctx.tenant_id),
                  eq(workflowVersions.id, wf.current_version_id),
                ),
              );
          } catch (err) {
            logger.warn({
              module: "conversation_tool",
              action: "run_workflow.scope_index_persist_failed",
              tenant_id: ctx.tenant_id,
              workflow_id: workflowId,
              workflow_version_id: wf.current_version_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      const boundDraft = bindPersistedWorkflow(previewedDraft, {
        kind: "workflow",
        id: workflowId,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.current_version_id,
        version: wf.current_version,
        environment: null,
        saved_at: wf.updated_at.toISOString(),
      });
      const nextDraft = withWorkflowExecution(boundDraft, {
        execution_id: result.execution_id,
        workflow_id: workflowId,
        workflow_version_id: wf.current_version_id,
        status: payloadStatus,
        environment: args.environment,
        warnings_count: result.warnings?.length ?? 0,
        recorded_at: new Date().toISOString(),
        diagnosis_available: diagnosisAvailable,
        ...(requiresRepair ? { requires_repair: true } : {}),
      });
      await ctx.setDraft(nextDraft);
      return {
        ok: result.status === "succeeded" && !isPartialSuccess,
        data: withStatus(
          buildLifecyclePayload(nextDraft, {
            execution_id: result.execution_id,
            workflow_id: workflowId,
            workflow_version_id: wf.current_version_id,
            workflow_version: wf.current_version,
            status: payloadStatus,
            output: result.output,
            error: result.error,
            diagnosis_available: diagnosisAvailable,
            requires_repair: requiresRepair,
            recommended_next_tool: diagnosisAvailable ? "diagnose_latest_execution" : null,
            // Plain-language summary + structured next-action hint.
            // The transcript captured the symptom: "Execution needs
            // diagnosis · 1 warning" with no inline explanation, so
            // the user had to drop out of chat to dig in. Surface a
            // single sentence the chat renderer (and the never-silent
            // guard) can read directly.
            ...(diagnosisAvailable && result.warnings && result.warnings.length > 0
              ? {
                  warning_summary: `${result.warnings.length} warning(s): ${Array.from(
                    new Set(result.warnings.map((w) => w.code)),
                  )
                    .sort()
                    .join(", ")}. Run \`diagnose_latest_execution\` for details.`,
                }
              : {}),
            next_best_actions: diagnosisAvailable
              ? ["diagnose_latest_execution"]
              : result.status === "succeeded"
                ? ["inspect_execution_step", "run_workflow"]
                : ["diagnose_latest_execution", "inspect_workflow"],
            next_prompt: diagnosisAvailable
              ? "Open diagnosis to see what happened"
              : result.status === "succeeded"
                ? "Inspect step output or run again"
                : "Diagnose the failure",
            // Banner-style warnings summary so the LLM can't miss
            // signals on first read of the result envelope. Mirrors
            // the dry_run_workflow surface.
            ...(hasWarnings && result.warnings
              ? {
                  warnings_banner: {
                    count: result.warnings.length,
                    codes: Array.from(new Set(result.warnings.map((w) => w.code))).sort(),
                    summary: `${result.warnings.length} warning(s): ${Array.from(
                      new Set(result.warnings.map((w) => w.code)),
                    )
                      .sort()
                      .join(", ")}`,
                    entries: result.warnings,
                  },
                }
              : {}),
            ...(hasWarnings ? { warnings: result.warnings } : {}),
            ...(includeStepTrace ? { step_trace: stepTraceEntries } : {}),
          }),
          // payloadStatus is one of the three terminal values (already
          // narrowed above), but withStatus is a no-op when the inner
          // payload already carries status — keep the default just in
          // case a future refactor drops the inline status.
          "failed",
        ),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.engineClient.audit_write({
        resource_type: "workflow",
        resource_id: workflowId,
        action: "conversation.run_workflow",
        result: "error",
        reason: msg,
        metadata: { conversation_id: ctx.conversation_id },
      });
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "run_failed",
            message: msg,
            recommended_mode: "execution",
          }),
          "failed",
        ),
      };
    }
  },
};
