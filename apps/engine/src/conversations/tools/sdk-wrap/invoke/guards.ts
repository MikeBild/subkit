import { log, logger } from "../../../../logging/logger.ts";
import { recordToolCircuitOpen } from "../../../../observability/instrumentation.ts";
import {
  argsHashOf,
  type CircuitBlock,
  consecutiveFailuresBlock,
  decideArgsRepeat,
  errorCodeRepeatBlock,
  isCircuitExempt,
  loopDetectedBlock,
  REPEAT_THRESHOLD,
} from "../../../core/tool-invoke.ts";
import { executionSuppressionRefusal } from "../../../execution-suppression.ts";
import { detectUserIntent } from "../../../intent-detector.ts";
import { isLiveExecutionTool, isWorkflowExecutionTool } from "../../authoring-palette.ts";
import { buildCapAlternatives } from "../error-recovery-hints.ts";
import {
  INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE,
  intakeReviewBlocksWrite,
} from "../intake-review-guard.ts";
import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_ERROR_CODE_REPEAT,
  type WrappedToolOutput,
} from "../state.ts";
import { type InvokeEnv, pushToolLog } from "./env.ts";

export type GuardOutcome = { blocked: WrappedToolOutput } | { argsHash: string };

async function surfaceRefusal(env: InvokeEnv): Promise<WrappedToolOutput | null> {
  const { inner, ctx } = env;
  const requestedExternalRead =
    inner.name === "run_workflow" &&
    detectUserIntent(ctx.recentUserMessage).requestExternalRead === true;
  const suppressionRefusal =
    isWorkflowExecutionTool(inner.name) && !requestedExternalRead
      ? await executionSuppressionRefusal({
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          recent_user_message: ctx.recentUserMessage ?? null,
          live_tool: isLiveExecutionTool(inner.name),
        })
      : null;
  if (suppressionRefusal) return { ok: false, data: suppressionRefusal };
  if (intakeReviewBlocksWrite(ctx.getDraft(), inner.name)) {
    return {
      ok: false,
      data: {
        error: "intake_review_requires_human_confirmation",
        error_code: "intake_review_requires_human_confirmation",
        next_best_actions: [],
        message: `This conversation is reviewing collected material. Create or revise an intake proposal; a person confirms the exact content, sources, and destination in the review before it becomes knowledge or a skill. ${INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE}`,
      },
    };
  }
  return null;
}

function openCircuit(env: InvokeEnv, block: CircuitBlock): void {
  recordToolCircuitOpen({ tool: env.inner.name, reason: block.circuitReason });
}

function consecutiveFailuresGuard(env: InvokeEnv): WrappedToolOutput | null {
  const { inner, ctx, signals } = env;
  if (signals.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return null;
  signals.totalLoopWarnings += 1;
  const block = consecutiveFailuresBlock(
    signals.consecutiveFailures,
    signals.totalLoopWarnings,
    buildCapAlternatives(signals.toolLastErrorHash),
  );
  openCircuit(env, block);
  logger.warn({
    module: "conversation_tool",
    action: "tool.consecutive_failures_block",
    msg: block.budgetReached
      ? "global consecutive-failures cap + turn loop budget exhausted — ending turn"
      : "global consecutive-failures cap reached — short-circuiting until model asks the user",
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    consecutive_failures: signals.consecutiveFailures,
    total_loop_warnings: signals.totalLoopWarnings,
    turn_budget_reached: block.budgetReached,
  });
  pushToolLog(env, "consecutive-failures-cap", block.eventMessage);
  return { ok: false, data: block.data };
}

function errorCodeRepeatGuard(env: InvokeEnv): WrappedToolOutput | null {
  const { inner, ctx, signals } = env;
  const errorCodeStreak = signals.toolErrorCodeRepeat.get(inner.name);
  if (!errorCodeStreak || errorCodeStreak.count < MAX_ERROR_CODE_REPEAT) return null;
  signals.totalLoopWarnings += 1;
  const block = errorCodeRepeatBlock(inner.name, errorCodeStreak, signals.totalLoopWarnings);
  openCircuit(env, block);
  logger.warn({
    module: "conversation_tool",
    action: "tool.error_code_repeat_block",
    msg: "same error_code repeated for one tool — short-circuiting until the model asks the user",
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    error_code: errorCodeStreak.code,
    repeat_count: errorCodeStreak.count,
    total_loop_warnings: signals.totalLoopWarnings,
    turn_budget_reached: block.budgetReached,
  });
  pushToolLog(env, "error-code-repeat", block.eventMessage);
  return { ok: false, data: block.data };
}

function argsRepeatGuard(env: InvokeEnv, argsHash: string): WrappedToolOutput | null {
  const { inner, ctx, signals } = env;
  const verdict = decideArgsRepeat({
    inner,
    argsHash,
    toolArgsRepeat: signals.toolArgsRepeat.get(inner.name),
    lastExecutionSuccess: signals.lastExecutionSuccess,
  });
  if (verdict.toolArgsRepeat) signals.toolArgsRepeat.set(inner.name, verdict.toolArgsRepeat);
  const priorCount = signals.toolInvocationCount.get(inner.name) ?? 0;
  if (!verdict.tripped) {
    signals.toolInvocationCount.set(inner.name, priorCount + 1);
    return null;
  }
  signals.totalLoopWarnings += 1;
  const block = loopDetectedBlock(inner.name, verdict, signals.totalLoopWarnings);
  log.conversation.tool.called({
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    step: signals.step,
  });
  openCircuit(env, block);
  logger.warn({
    module: "conversation",
    action: "tool.loop_detected",
    msg: block.budgetReached
      ? "turn loop budget exhausted — ending turn"
      : "same args submitted to a write tool 3× in a row — aborting further calls",
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    tool_count: priorCount,
    repeat_count: verdict.repeatCount,
    args_hash: argsHash.slice(0, 64),
    total_loop_warnings: signals.totalLoopWarnings,
    repeat_threshold: REPEAT_THRESHOLD,
    repeats_successful_execution: verdict.repeatsSuccessfulExecution,
    turn_budget_reached: block.budgetReached,
  });
  pushToolLog(env, "loop-detected", block.eventMessage);
  return { ok: false, data: block.data };
}

export async function runGuards(
  env: InvokeEnv,
  rawArgs: Record<string, unknown>,
): Promise<GuardOutcome> {
  const refusal = await surfaceRefusal(env);
  if (refusal) return { blocked: refusal };
  if (!isCircuitExempt(env.inner.name)) {
    const capped = consecutiveFailuresGuard(env) ?? errorCodeRepeatGuard(env);
    if (capped) return { blocked: capped };
  }
  const argsHash = argsHashOf(rawArgs);
  const looped = argsRepeatGuard(env, argsHash);
  if (looped) return { blocked: looped };
  return { argsHash };
}
