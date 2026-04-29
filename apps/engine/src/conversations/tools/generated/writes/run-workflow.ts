// run_workflow tool — executes a workflow synchronously in the tenant's
// dev environment (unless the caller opts into prod). Writes an audit
// entry on each attempt.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { conversations, conversationToolCalls } from "../../../../db/schema/index.ts";
import { runExecution } from "../../../../execution/engine.ts";
import { logger } from "../../../../logging/logger.ts";
import { bindPersistedWorkflow, withWorkflowExecution } from "../../../authoring-state.ts";
import { buildGateError, buildLifecyclePayload } from "../../authoring-contract.ts";
import type { ConversationTool } from "../../index.ts";

/**
 * Circuit-breaker for repair loops. Walks the recent tool-call
 * history for this conversation and counts how many `run_workflow` /
 * `dry_run_workflow` invocations produced an `unresolved_identifier`
 * warning. Three identical occurrences in a row signal "the LLM is
 * stuck rewriting the same JSONata five different ways and every
 * attempt produces the same warning" — exactly the v3→v4→v5 spiral
 * the user reported. We refuse and surface a structured halt instead
 * of letting the LLM burn another 88k tokens.
 */
async function detectRepairLoop(
  db: ReturnType<typeof eq> extends never ? never : import("../../../../db/client.ts").Db,
  tenant_id: string,
  conversation_id: string,
): Promise<{ tripped: boolean; recent_codes: string[] }> {
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
    for (const r of rows) {
      if (r.tool !== "run_workflow" && r.tool !== "dry_run_workflow") continue;
      const data = r.output as { data?: { warnings?: Array<{ code?: unknown }> } } | null;
      const ws = data?.data?.warnings;
      if (!Array.isArray(ws)) continue;
      for (const w of ws) {
        if (w && typeof w.code === "string") codes.push(w.code);
      }
    }
    const unresolvedCount = codes.filter((c) => c === "unresolved_identifier").length;
    return { tripped: unresolvedCount >= 3, recent_codes: codes.slice(0, 8) };
  } catch {
    return { tripped: false, recent_codes: [] };
  }
}

const Input = z
  .object({
    workflow_id: z.string().uuid().optional(),
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
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

    // Circuit-breaker: refuse to run when the same `unresolved_identifier`
    // warning has fired three times in this conversation. The LLM is
    // chasing a fix that isn't working; another run won't tell it
    // anything new and burns tokens.
    const breaker = await detectRepairLoop(ctx.db, ctx.tenant_id, ctx.conversation_id);
    if (breaker.tripped) {
      logger.warn({
        module: "conversation_tool",
        action: "run_workflow.repair_loop_detected",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        recent_codes: breaker.recent_codes,
      });
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "repair_loop_detected",
            message:
              "stop — three consecutive runs of this workflow surfaced the same `unresolved_identifier` warning. The current strategy is not working. Read `data-handling.md` and `workflow-authoring.md` for the loop+JSONata scope rules, ask the user what output they actually want, and propose a structurally different draft. Re-running this one will produce the same warning.",
            recommended_mode: "diagnosis",
            next_best_actions: [
              "ask_user_text",
              "diagnose_latest_execution",
              "load_skill",
              "search_knowledge",
            ],
            extra: {
              recent_warning_codes: breaker.recent_codes,
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
      const hasTransformDroppedFieldsWarning = (result.warnings ?? []).some(
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
      const boundDraft = bindPersistedWorkflow(currentDraft, {
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
            ...(hasWarnings ? { warnings: result.warnings } : {}),
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
