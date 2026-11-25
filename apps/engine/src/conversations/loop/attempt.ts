import { type ModelMessage, streamText, type ToolSet } from "ai";
import { actorFields } from "../../llm/accounting/index.ts";
import { isReasoningModel } from "../../llm/runtime/ai-sdk-model.ts";
import {
  type CacheBlocks,
  promptCacheKeyFor,
  promptCacheSupported,
  splitPromptIntoBlocks,
  stablePrefixHash,
  toolPaletteHash,
  toSystemMessages,
  withHistoryCacheBreakpoint,
} from "../../llm/runtime/cache-blocks.ts";
import {
  anthropicWebSearchApplies,
  buildAnthropicWebSearchTool,
  nativeWebSearchSetting,
} from "../../llm/runtime/model-init.ts";
import { repairToolCall as repairToolCallHandler } from "../../llm/runtime/repair-tool-call.ts";
import { PROVIDER_RESPONSE_TIMEOUT_MS } from "../../llm/runtime/response-timeout.ts";
import { supportsExtendedThinking } from "../../llm/runtime/step-router.ts";
import {
  readReasoningEffortSetting,
  resolveTurnReasoning,
} from "../../llm/runtime/thinking-policy.ts";
import { logger } from "../../logging/index.ts";
import {
  recordConversationRepair,
  recordConversationStep,
  recordLlmStepTimeout,
} from "../../observability/instrumentation.ts";
import { timePhase } from "../../observability/runtime-telemetry.ts";
import {
  enrichActiveSpan,
  isTracingActive,
  toolSpanAttributes,
} from "../../observability/tracing.ts";
import { now } from "../../utils/clock.ts";
import { abortTimeout, isLateStage, repairAttribution, turnBudgetMs } from "../core/loop.ts";
import { turnToolChoice } from "../intent-detector.ts";
import { type ConversationTool, listTools } from "../tools/index.ts";
import { taskRunAllowsWebSearch, taskRunMarkerOf } from "../tools/sdk-wrap/task-run-guard.ts";
import { LlmTimeoutError, timeoutPhaseOf } from "../turn-failure.ts";
import { assertConversationTurn } from "../turns.ts";
import { MAX_REPAIRS_PER_TURN, resolveLanguageModel } from "./model-resolver.ts";
import { conversationMessages } from "./shared.ts";
import { finishAttemptStep } from "./step-finish.ts";
import { prepareAttemptStep } from "./step-prepare.ts";
import { consumeAttemptStream } from "./stream.ts";
import type { Attempt, ModelRoute, TurnEnv, TurnState } from "./types.ts";

export const CONVERSE_FIRST_CHUNK_TIMEOUT_MS = PROVIDER_RESPONSE_TIMEOUT_MS;

let firstChunkTimeoutMsOverride: number | null = null;
export function _setConverseFirstChunkTimeoutMsForTests(ms: number | null): void {
  firstChunkTimeoutMsOverride = ms;
}

function resolveThinking(
  env: TurnEnv,
  state: TurnState,
  attempt: Attempt,
  cacheSupported: boolean,
) {
  const { p } = env;
  const { provider, modelId } = attempt;
  const turnStageReadOnly = false;
  const thinkingDecision = resolveTurnReasoning({
    setting: readReasoningEffortSetting(p.tenant_id),
    lateStage: isLateStage(state.draft.summary?.stage),
    supportsThinking: supportsExtendedThinking(provider, modelId),
    supportsReasoningEffort: provider === "openai" && isReasoningModel(modelId),
    forcesTool: env.preferredTool != null,
  });
  logger.debug({
    module: "llm",
    action: "turn.provider_options",
    msg: "resolved per-turn provider gates",
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    provider,
    model: modelId,
    stage: state.draft.summary?.stage ?? "idle",
    parallel_tools_enabled: turnStageReadOnly,
    extended_thinking_enabled: thinkingDecision.enabled,
    reasoning_effort: thinkingDecision.effort,
    reasoning_source: thinkingDecision.source,
    thinking_suppressed_by_forced_tool: thinkingDecision.suppressedByForcedTool,
    cache_supported: cacheSupported,
  });
  return { thinkingDecision, turnStageReadOnly };
}

function onAttemptAbort(env: TurnEnv, attempt: Attempt, event: unknown): void {
  if (env.abort.signal.aborted || attempt.timeoutError) return;
  const reason = (event as { reason?: unknown }).reason;
  const { phase, timeoutMs } = abortTimeout({
    reportedPhase: timeoutPhaseOf(reason),
    elapsedMs: now() - attempt.streamStartedAt,
    turnBudgetMs: attempt.turnBudgetMs,
    firstChunkMs: attempt.firstChunkTimeoutMs,
  });
  attempt.timeoutError = new LlmTimeoutError(phase, timeoutMs, { cause: reason });
  recordLlmStepTimeout({ phase });
  logger.warn({
    module: "llm",
    action: "converse.timeout",
    msg: "stream aborted by the typed SDK timeout",
    conversation_id: env.p.conversation_id,
    tenant_id: env.p.tenant_id,
    provider: attempt.provider,
    model: attempt.modelId,
    phase,
    timeout_ms: timeoutMs,
    elapsed_ms: Math.round(now() - attempt.streamStartedAt),
  });
}

function attemptProviderOptions(
  env: TurnEnv,
  provider: ModelRoute["provider"],
  cacheSupported: boolean,
  turnStageReadOnly: boolean,
) {
  if (cacheSupported)
    return { providerOptions: { anthropic: { disableParallelToolUse: !turnStageReadOnly } } };
  if (provider === "openai")
    return {
      providerOptions: {
        openai: { promptCacheKey: promptCacheKeyFor(env.p.tenant_id, env.p.conversation_id) },
      },
    };
  return {};
}

function logPromptPrefix(
  env: TurnEnv,
  attempt: Attempt,
  cacheBlocks: CacheBlocks,
  cacheSupported: boolean,
): void {
  const toolNames = Object.keys(attempt.turnTools);
  logger.info({
    module: "llm",
    action: "converse.prompt_prefix",
    msg: "prompt prefix sent to the provider",
    conversation_id: env.p.conversation_id,
    tenant_id: env.p.tenant_id,
    provider: attempt.provider,
    model: attempt.modelId,
    stable_prefix_hash: stablePrefixHash(cacheBlocks),
    stable_tokens: cacheBlocks.token_counts.stable,
    volatile_tokens: cacheBlocks.token_counts.volatile,
    tool_palette_hash: toolPaletteHash(toolNames),
    tool_count: toolNames.length,
    cache_breakpoints: cacheSupported ? ["system", "history"] : [],
    prompt_cache_key: !cacheSupported && attempt.provider === "openai",
  });
}

export async function runAttempt(
  env: TurnEnv,
  state: TurnState,
  modelId: string,
  provider: ModelRoute["provider"],
  prebuiltMessages?: ModelMessage[],
): Promise<void> {
  const { p, events, stepRouterSignals } = env;
  await assertConversationTurn(env.abort.signal);
  const startedAt = now();
  const historyMessages = prebuiltMessages ?? (await conversationMessages(p));
  const resolvedModel = await resolveLanguageModel(provider, modelId, p.tenant_id, p.db);
  const budgetMs = turnBudgetMs(env.budget);
  const firstChunkTimeoutMs = firstChunkTimeoutMsOverride ?? CONVERSE_FIRST_CHUNK_TIMEOUT_MS;
  const streamStartedAt = now();
  const cacheSupported = promptCacheSupported(provider, modelId);
  const cacheBlocks = timePhase("converse.split_cache_blocks", () =>
    splitPromptIntoBlocks(env.prompt, "converse"),
  );
  const systemMessages = toSystemMessages(cacheBlocks, { enabled: cacheSupported, ttl: "1h" });
  const attemptMessages = withHistoryCacheBreakpoint(historyMessages, {
    enabled: cacheSupported,
    ttl: "1h",
  });
  events.push({ type: "activity", phase: "composing", label: "composing reply" });
  const toolsByName: Record<string, ConversationTool> = {};
  for (const t of listTools()) toolsByName[t.name] = t;
  const attempt: Attempt = {
    modelId,
    provider,
    resolvedModel,
    baselineIndex: attemptMessages.length,
    systemMessages,
    toolsByName,
    thinkingThisTurn: false,
    turnTools: env.tools,
    turnBudgetMs: budgetMs,
    firstChunkTimeoutMs,
    streamStartedAt,
    lastStepEnd: startedAt,
    activeStepModel: modelId,
    turnRepairCount: 0,
    capturedError: undefined,
    timeoutError: null,
  };
  const { thinkingDecision, turnStageReadOnly } = resolveThinking(
    env,
    state,
    attempt,
    cacheSupported,
  );
  attempt.thinkingThisTurn = thinkingDecision.enabled;
  const webSearchSetting = nativeWebSearchSetting(p.tenant_id);
  const webSearchEnabled =
    taskRunAllowsWebSearch(taskRunMarkerOf(env.ctx)) &&
    anthropicWebSearchApplies(provider, modelId, webSearchSetting);
  const turnTools: ToolSet = webSearchEnabled
    ? { ...env.tools, web_search: buildAnthropicWebSearchTool(5, p.tenant_id) }
    : env.tools;
  attempt.turnTools = turnTools;
  logPromptPrefix(env, attempt, cacheBlocks, cacheSupported);
  const result = streamText({
    model: resolvedModel,
    instructions: systemMessages,
    messages: attemptMessages,
    allowSystemInMessages: true,
    tools: turnTools,
    toolOrder: [],
    toolChoice: turnToolChoice(env.preferredTool, env.forceNoTools),
    reasoning: thinkingDecision.effort,
    ...attemptProviderOptions(env, provider, cacheSupported, turnStageReadOnly),
    experimental_repairToolCall: ({ toolCall, tools: callTools, error, messages, system }) => {
      if (attempt.turnRepairCount >= MAX_REPAIRS_PER_TURN) {
        recordConversationRepair({ kind: "capped" });
        logger.warn({
          module: "llm",
          action: "repair_tool_call.capped",
          msg: "per-turn repair cap reached — surfacing failure to the loop",
          conversation_id: p.conversation_id,
          tool: toolCall.toolName,
          cap: MAX_REPAIRS_PER_TURN,
        });
        return Promise.resolve(null);
      }
      attempt.turnRepairCount += 1;
      return repairToolCallHandler({
        toolCall,
        tools: callTools,
        messages,
        system,
        error,
        model: resolvedModel,
        accounting: {
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          ...actorFields(p.principal),
          db: p.db,
        },
        onRepair: () => {
          recordConversationRepair({ kind: "repaired" });
          stepRouterSignals.hadRepairThisTurn = true;
          stepRouterSignals.repairAttribution = repairAttribution(toolCall.toolName, error);
        },
      });
    },
    prepareStep: (step) => prepareAttemptStep(env, state, attempt, step),
    stopWhen: env.stopWhen,
    maxRetries: 2,
    abortSignal: env.abort.signal,
    timeout: { totalMs: budgetMs, firstChunkMs: firstChunkTimeoutMs },
    onAbort: (event) => onAttemptAbort(env, attempt, event),
    onStepStart: ({ modelId: stepModelId }) => {
      recordConversationStep({ stage: stepRouterSignals.stage ?? "idle", model: stepModelId });
    },
    onToolExecutionEnd: ({ toolExecutionMs }) => {
      enrichActiveSpan(toolSpanAttributes({ duration_ms: toolExecutionMs }));
    },
    runtimeContext: {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      provider,
      model: modelId,
    },
    telemetry: {
      isEnabled: true,
      recordInputs: isTracingActive(),
      recordOutputs: isTracingActive(),
      functionId: "converse",
      includeRuntimeContext: {
        tenant_id: true,
        conversation_id: true,
        provider: true,
        model: true,
      },
    },
    onError: ({ error }) => {
      if (!attempt.capturedError) attempt.capturedError = error;
    },
    onStepFinish: (step) => finishAttemptStep(env, state, attempt, step),
  });
  await consumeAttemptStream(env, attempt, result);
}
