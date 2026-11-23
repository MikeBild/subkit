import { logger } from "../../../../logging/index.ts";
import { stripConfirmMarkers } from "../../../../tools/approval.ts";
import { now } from "../../../../utils/clock.ts";
import { recordTransition, runConfirmGate } from "../../../confirmation.ts";
import {
  duplicatePendingOutput,
  executionModeFor,
  gateFailureData,
  policyEnvironmentOf,
} from "../../../core/tool-invoke.ts";
import { coverForCall, settleCover } from "../../../instruction-cover/invoke.ts";
import { findPriorSaveWorkflowApproval } from "../../../persistence/save-workflow-approval.ts";
import type { ToolResult } from "../../index.ts";
import { resolveConversationPrincipal } from "../../permission-gate.ts";
import { prepareGate } from "../gate-subjects.ts";
import { mapToolToCommitIntentKind, topLevelElicitationKindForTool } from "../policy-helpers.ts";
import { checkBeforeGate } from "../pregate.ts";
import type { WrappedToolOutput } from "../state.ts";
import { taskRunMarkerOf } from "../task-run-guard.ts";
import { pauseForConfirmation } from "./confirm.ts";
import { type InvokeCall, type InvokeEnv, persistToolResult, recordCall } from "./env.ts";
import { type GateCoverage, runWorkflowToolCoverage } from "./run-coverage.ts";

const PRIOR_APPROVAL_WINDOW_MS = 5 * 60 * 1000;

export type Gate = Awaited<ReturnType<typeof runConfirmGate>>;
export type PreparedGate = Awaited<ReturnType<typeof prepareGate>>;
export type Principal = Awaited<ReturnType<typeof resolveConversationPrincipal>>;

export interface GatePassed {
  principal: Principal;
  pregateRefusal: ToolResult | null;
  resolvedMode: Gate["record"]["mode"];
  resolvedRule: Gate["record"]["rule"];
  coverage: GateCoverage;
  covered_digest?: string;
}

export type GateOutcome = { done: WrappedToolOutput } | { passed: GatePassed };

async function hasPriorApproval(env: InvokeEnv): Promise<boolean> {
  const { inner, db, ctx } = env;
  if (inner.name !== "save_workflow_draft") return false;
  try {
    const approval = await findPriorSaveWorkflowApproval(db, ctx.tenant_id, ctx.conversation_id);
    return Boolean(
      approval && Date.now() - (approval.created_at?.getTime() ?? 0) < PRIOR_APPROVAL_WINDOW_MS,
    );
  } catch {
    return false;
  }
}

export async function runGate(env: InvokeEnv, call: InvokeCall): Promise<GateOutcome> {
  const { inner, ctx, signals, db, toolPolicies, askBeforeWriting } = env;
  const { rawArgs, perCallCtx, toolCallId } = call;
  const policyEnvironment = policyEnvironmentOf(rawArgs);
  const intentKindForCurrentTool = mapToolToCommitIntentKind(inner.name);
  const priorApproval = await hasPriorApproval(env);
  const principal = ctx.principal ?? (await resolveConversationPrincipal(perCallCtx));
  const pendingElicitationBeforeGate = signals.pendingElicitation;
  const preparedGate = await prepareGate(
    inner.name,
    stripConfirmMarkers(rawArgs),
    ctx.tenant_id,
    db,
    ctx.locale,
    principal,
  );
  const coverage = await runWorkflowToolCoverage(
    perCallCtx,
    inner.name === "run_workflow" && askBeforeWriting,
    preparedGate.args,
    toolPolicies,
  );
  const cover = await coverForCall(env, principal, preparedGate.args, new Date(now()));
  const gate = await runConfirmGate({
    tool: inner.name,
    category: inner.category,
    surface: "chat",
    args: preparedGate.args,
    overrides: toolPolicies,
    ...(askBeforeWriting ? { ask_before_writing: true } : {}),
    prior_approval: priorApproval,
    ...(cover.instruction_covered ? { instruction_covered: true } : {}),
    ...(cover.rule_covered ? { rule_covered: true } : {}),
    ...(preparedGate.execution_data_transfer ? { execution_data_transfer: true } : {}),
    ...(coverage.covered ? { authority_covered: true } : {}),
    ...(taskRunMarkerOf(ctx) ? { task_run: true } : {}),
    db,
    tenant_id: ctx.tenant_id,
    principal,
    approval_tool: inner.name,
    via: "chat",
    record_surface: ctx.surface ?? "api",
    conversation_id: ctx.conversation_id,
    actor_id: ctx.actor_id ?? null,
    execution_mode: executionModeFor(policyEnvironment),
    precheck: () => checkBeforeGate(inner, perCallCtx, rawArgs),
    pause_blocked: pendingElicitationBeforeGate !== undefined,
    confirmation_kind: topLevelElicitationKindForTool(inner.name),
    ...(policyEnvironment !== undefined ? { environment: policyEnvironment } : {}),
  });
  const resolvedMode = gate.record.mode;
  if (gate.kind === "proceed" && resolvedMode === "confirm_before_execution") {
    logger.info({
      module: "conversation_tool",
      action: "policy.gate_skipped",
      msg: "policy gate skipped despite confirm_before_execution mode",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool: inner.name,
      category: inner.category,
      skip_reason: gate.decision.skip_reason,
      ...(intentKindForCurrentTool ? { intent_kind: intentKindForCurrentTool } : {}),
    });
  }
  const pregateRefusal = gate.kind === "refused" ? gate.result : null;

  if (inner.category === "tenant_write" && !pregateRefusal) {
    await recordTransition(db, {
      tool_call_id: toolCallId,
      tenant_id: ctx.tenant_id,
      to_state: "proposed",
      actor_id: ctx.actor_id,
      tool: inner.name,
      data: {
        resolved_mode: resolvedMode,
        ...(askBeforeWriting ? { ask_before_writing: true } : {}),
      },
    });
  }

  const settled = await settleCover(env, call, cover, gate);
  if (settled) return { done: settled };

  if (gate.kind === "duplicate_pending") {
    const dupOutput = duplicatePendingOutput(pendingElicitationBeforeGate);
    await persistToolResult(env, call, dupOutput, "denied");
    recordCall(env, call, "denied");
    return { done: { ok: false, data: dupOutput } };
  }

  if (gate.kind === "approval_failed" || gate.kind === "unavailable") {
    const failure = { ok: false as const, data: gateFailureData(gate, inner.name) };
    await persistToolResult(env, call, failure.data, "error");
    recordCall(env, call, "error");
    return { done: failure };
  }

  if (gate.kind === "needs_confirm") {
    return { done: await pauseForConfirmation(env, call, gate, preparedGate) };
  }

  const ranOnCover =
    gate.record.rule === "user_instruction" || gate.record.rule === "standing_rule";
  return {
    passed: {
      principal,
      pregateRefusal,
      resolvedMode,
      resolvedRule: gate.record.rule,
      coverage,
      ...(ranOnCover && cover.covered_digest ? { covered_digest: cover.covered_digest } : {}),
    },
  };
}
