import { log, logger } from "../../../../logging/index.ts";
import {
  recordConversationToolError,
  recordToolCircuitOpen,
} from "../../../../observability/instrumentation.ts";
import {
  failureSignature,
  nextErrorCodeStreak,
  nextFingerprintStreak,
  tracksExecutionSuccess,
  validationErrorsOf,
} from "../../../core/tool-invoke.ts";
import { appendMessage } from "../../../persistence/index.ts";
import { buildCapAlternatives, metricErrorCode } from "../error-recovery-hints.ts";
import { summarizeToolData, summarizeToolFailure } from "../policy-helpers.ts";
import {
  computeValidationFingerprint,
  MAX_CONSECUTIVE_FAILURES,
  MAX_VALIDATION_FINGERPRINT_REPEAT,
} from "../state.ts";
import { type InvokeCall, type InvokeEnv, pushToolLog, recordCall } from "./env.ts";
import type { Executed } from "./execute.ts";

function recordValidationFingerprint(env: InvokeEnv, errors: unknown[]): void {
  const { inner, ctx, signals } = env;
  const fingerprint = computeValidationFingerprint(
    errors as Array<{ path?: unknown; message?: unknown }>,
  );
  if (!fingerprint) return;
  const next = nextFingerprintStreak(
    signals.toolValidationFingerprint.get(inner.name),
    fingerprint,
  );
  signals.toolValidationFingerprint.set(inner.name, next);
  if (next.count < MAX_VALIDATION_FINGERPRINT_REPEAT) return;
  logger.warn({
    module: "conversation_tool",
    action: "tool.validation_fingerprint_cap",
    msg: "same validation error shape repeated — model must ask user or change approach",
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    fingerprint,
    repeat_count: next.count,
  });
  recordToolCircuitOpen({ tool: inner.name, reason: "validation_fingerprint_repeat" });
  pushToolLog(
    env,
    "validation-fingerprint-cap",
    `tool.validation_fingerprint_cap: ${inner.name} hit the SAME validation error shape ${next.count}× — different args, same constraint. Stop iterating; emit ask_user_choice / ask_user_text describing the constraint and offering a path forward (e.g. simpler workflow, different connector field, hand-edited JSON).`,
  );
}

function recordFailureSignals(env: InvokeEnv, resultPayload: unknown): void {
  const { inner, ctx, signals } = env;
  const { reason, shape } = failureSignature(resultPayload);
  signals.toolLastErrorHash.set(inner.name, shape);
  if (reason) {
    signals.toolErrorCodeRepeat.set(
      inner.name,
      nextErrorCodeStreak(signals.toolErrorCodeRepeat.get(inner.name), reason),
    );
  }
  const errors = ((resultPayload ?? {}) as Record<string, unknown>).errors;
  if (Array.isArray(errors)) recordValidationFingerprint(env, errors);
  signals.consecutiveFailures += 1;
  if (signals.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return;
  logger.warn({
    module: "conversation_tool",
    action: "tool.consecutive_failures_cap",
    msg: "five consecutive failed tool calls — model must ask the user before continuing",
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    consecutive_failures: signals.consecutiveFailures,
  });
  const capAlternatives = buildCapAlternatives(signals.toolLastErrorHash);
  pushToolLog(
    env,
    "consecutive-failures",
    `tool.consecutive_failures_cap: ${signals.consecutiveFailures} failed tool calls in a row — emit ask_user_choice / ask_user_text instead of patching further.${capAlternatives}`,
  );
}

function recordSuccessSignals(env: InvokeEnv, call: InvokeCall, resultPayload: unknown): void {
  const { inner, signals } = env;
  signals.toolLastErrorHash.delete(inner.name);
  signals.toolValidationFingerprint.delete(inner.name);
  signals.toolErrorCodeRepeat.delete(inner.name);
  signals.consecutiveFailures = 0;
  if (call.argsHash && tracksExecutionSuccess(inner.name)) {
    signals.lastExecutionSuccess = {
      tool: inner.name,
      args_hash: call.argsHash,
      output: resultPayload,
    };
  }
}

export async function recordOutcome(
  env: InvokeEnv,
  call: InvokeCall,
  executed: Executed,
  committedWorkflowId: string | null,
): Promise<void> {
  const { inner, ctx, events, db } = env;
  const { result, resultPayload } = executed;
  const logCtx = {
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    ok: result.ok,
    paused: Boolean(result.pause),
    committed: Boolean(committedWorkflowId),
    duration_ms: Date.now() - call.startedAt,
    ...summarizeToolData(resultPayload),
    ...summarizeToolFailure(result),
  };
  if (result.ok) log.conversation.tool.succeeded(logCtx);
  else log.conversation.tool.failed(logCtx);
  recordCall(env, call, result.ok ? "ok" : "error");
  if (!result.ok) {
    recordConversationToolError({ tool: inner.name, error_code: metricErrorCode(result) });
  }

  if (result.ok) recordSuccessSignals(env, call, resultPayload);
  else recordFailureSignals(env, resultPayload);

  await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "tool", {
    tool: inner.name,
    output: resultPayload,
  });

  const validationErrors = result.ok ? null : validationErrorsOf(resultPayload);
  if (validationErrors) {
    events.push({
      type: "validation_error",
      errors: validationErrors as Array<{ path: string; message: string }>,
    });
  }
}
