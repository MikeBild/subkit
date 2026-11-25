import type { StepResult, ToolSet } from "ai";
import { actorFields, recordUsage } from "../../llm/accounting/index.ts";
import { runOutputGuard } from "../../llm/output-guard/index.ts";
import { logger } from "../../logging/index.ts";
import { recordLlmTokens } from "../../observability/instrumentation.ts";
import { readMemoryUsage, timePhaseAsync } from "../../observability/runtime-telemetry.ts";
import { now } from "../../utils/clock.ts";
import { outputGuardContext, toMegabytes } from "../core/loop.ts";
import { setElicitationParentMessage } from "../elicitations.ts";
import {
  appendMessage,
  setToolCallParentMessage,
  updateMessageContent,
} from "../persistence/index.ts";
import { answeringModelLabel } from "./model-resolver.ts";
import type { Attempt, TurnEnv, TurnState } from "./types.ts";
import { readStepUsage, stepPromptTokens, stepTotalTokens } from "./usage.ts";

async function logStepMemory(): Promise<void> {
  const m = readMemoryUsage();
  const external_mb = toMegabytes(m.external);
  let heap_top: Array<[string, number]> | undefined;
  let heap_size_mb: number | undefined;
  if (external_mb > 768) {
    try {
      const { heapStats } = await import("bun:jsc");
      const h = heapStats();
      heap_size_mb = toMegabytes(h.heapSize);
      heap_top = Object.entries(h.objectTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8) as Array<[string, number]>;
    } catch {}
  }
  logger.info({
    module: "process",
    action: "step.memory",
    at: "finish",
    external_mb,
    rss_mb: toMegabytes(m.rss),
    ...(heap_size_mb !== undefined ? { heap_size_mb } : {}),
    ...(heap_top ? { heap_top } : {}),
  });
}

async function recordStepUsage(
  env: TurnEnv,
  state: TurnState,
  attempt: Attempt,
  step: StepResult<ToolSet>,
): Promise<void> {
  const { p } = env;
  const u = readStepUsage(step);
  state.promptTokensLastCall = stepPromptTokens(u);
  state.turnTokensTotal += stepTotalTokens(u);
  state.turnInputTokens += u.inputTokens;
  state.turnCacheReadTokens += u.cacheReadTokens;
  state.turnCacheCreationTokens += u.cacheCreationTokens;
  state.turnCacheReported ||= u.cacheReported;
  const stepEndedAt = now();
  const latency_ms = Math.max(0, stepEndedAt - attempt.lastStepEnd);
  attempt.lastStepEnd = stepEndedAt;
  await recordUsage(
    {
      tenant_id: p.tenant_id,
      flow: "converse",
      model: attempt.activeStepModel,
      prompt_tokens: u.inputTokens,
      completion_tokens: u.outputTokens,
      cache_read_tokens: u.cacheReadTokens,
      cache_creation_tokens: u.cacheCreationTokens,
      cache_reported: u.cacheReported,
      latency_ms,
      result: "success",
      conversation_id: p.conversation_id,
      ...actorFields(p.principal),
    },
    p.db,
  );
  recordLlmTokens({
    tenant_id: p.tenant_id,
    model: attempt.activeStepModel,
    flow: "converse",
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
  });
}

async function persistAssistantStep(
  env: TurnEnv,
  attempt: Attempt,
  text: string,
  hasText: boolean,
): Promise<void> {
  const { p, signals } = env;
  const guarded = hasText
    ? runOutputGuard(text, outputGuardContext(env.engineUrl, p.runtime_context?.tenant_slug))
    : { text: "", violations: [] };
  const assistantContent = {
    text: hasText ? guarded.text : "",
    ...(guarded.violations.length > 0
      ? {
          _violations: guarded.violations.map((v) => ({
            kind: v.kind,
            message: v.message,
          })),
        }
      : {}),
  };
  const model = answeringModelLabel(attempt.provider, attempt.activeStepModel);
  const assistantMessageId =
    signals.assistantMessageId ??
    (await appendMessage(p.db, p.tenant_id, p.conversation_id, "assistant", assistantContent, {
      model,
    }));
  if (signals.assistantMessageId) {
    await updateMessageContent(p.db, assistantMessageId, assistantContent, { model });
  }
  await setToolCallParentMessage(p.db, signals.pendingChildToolCallIds, assistantMessageId);
  await setElicitationParentMessage(p.db, signals.pendingChildElicitationIds, assistantMessageId);
  signals.pendingChildToolCallIds = [];
  signals.pendingChildElicitationIds = [];
  signals.assistantMessageId = null;
  signals.lastAssistantMessageId = assistantMessageId;
  if (hasText) {
    signals.lastAssistantText = guarded.text;
  }
  env.events.push({
    type: "message",
    role: "assistant",
    content: assistantContent,
    id: assistantMessageId,
    parent_message_id: assistantMessageId,
  });
}

export function finishAttemptStep(
  env: TurnEnv,
  state: TurnState,
  attempt: Attempt,
  step: StepResult<ToolSet>,
) {
  return timePhaseAsync("converse.on_step_finish", async () => {
    await logStepMemory();
    await recordStepUsage(env, state, attempt, step);
    const hasText = !!step.text && step.text.length > 0;
    state.lastStepHadText = hasText;
    const hasPendingChildren =
      env.signals.pendingChildToolCallIds.length > 0 ||
      env.signals.pendingChildElicitationIds.length > 0;
    if (hasText || hasPendingChildren) await persistAssistantStep(env, attempt, step.text, hasText);
  });
}
