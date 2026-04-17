// Conversation tool-use loop, SDK-driven.
//
// The loop hands turn execution to `streamText` with our tool palette
// wrapped via `tool()`. Stop conditions halt the run on step-count
// exhaustion, `request_human_approval` (pause for operator), or a
// `commit_draft` that returned a `committed_workflow_id`. Each tool's
// side-effects (DB row inserts, event emission, logging, approval
// creation) happen inside the `sdk-wrap` adapter — this file's job is
// composing the call, mapping callbacks into DB writes + events, and
// resolving the final per-turn status.

import { hasToolCall, stepCountIs, streamText } from "ai";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversations } from "../db/schema/index.ts";
import { checkAndDecrement, checkBudget, monthlyUsage, recordUsage } from "../llm/budgets.ts";
import { assembleEnhancedPrompt } from "../llm/context.ts";
import { LlmProviderError, LlmQuotaExhausted } from "../llm/errors.ts";
import { createMockLanguageModel } from "../llm/mock-stream.ts";
import { modelRegistry, resolveModelRoute } from "../llm/provider.ts";
import { log, logger } from "../logging/logger.ts";
import { recordLlmQuotaExhausted, recordLlmTokens } from "../observability/instrumentation.ts";
import { loadDraft } from "./draft.ts";
import { appendMessage, buildModelMessages } from "./persist.ts";
import type { ToolContext } from "./tools/index.ts";
import { type TurnSignals, wrapTools } from "./tools/sdk-wrap.ts";
import type { DraftDocument, TurnEvent } from "./types.ts";

export interface RunLoopParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  connector_id: string | null;
  workflow_id: string | null;
  user_message: string | null;
  step_budget?: number;
  /** Optional user-supplied memory payload to thread into context assembly. */
  user_memory?: string | null;
  /** Optional per-turn model override resolved from conversations.model. */
  model_override?: string | null;
}

export interface RunLoopResult {
  events: TurnEvent[];
  status: "awaiting_input" | "committed" | "active" | "exhausted";
  committed_workflow_id?: string;
  pending_elicitation_id?: string;
}

const DEFAULT_BUDGET = 20;

/**
 * Resolve the SDK language model for this run. The mock provider
 * returns a fresh `MockLanguageModelV3` that reads from the shared
 * plan-cursor singleton; real providers go through the provider
 * registry (A1) so the `anthropic:` prefix is stripped natively.
 */
function resolveLanguageModel(provider: string, modelId: string) {
  if (provider === "mock") return createMockLanguageModel(modelId);
  const bare = modelId.startsWith("anthropic:") ? modelId.slice("anthropic:".length) : modelId;
  return modelRegistry.languageModel(`anthropic:${bare}`);
}

/**
 * Stop after a step that invoked `commit_draft` and produced a
 * `committed_workflow_id` — the loop is done the moment the workflow
 * row is persisted.
 *
 * Typed `any` against the SDK's StopCondition generic because our
 * concrete tool map and the SDK's variadic ToolSet do not reconcile
 * at the type level; the runtime contract is a predicate over
 * `steps[last].toolResults`.
 */
const committedStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<{
    toolResults: ReadonlyArray<{ toolName: string; output?: unknown }>;
  }>;
}): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((r) => {
    if (r.toolName !== "commit_draft") return false;
    const output = r.output;
    return (
      !!output &&
      typeof output === "object" &&
      "committed_workflow_id" in (output as Record<string, unknown>) &&
      typeof (output as { committed_workflow_id?: unknown }).committed_workflow_id === "string"
    );
  });
};

interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Classify an error thrown from `streamText` into our provider-kind
 * taxonomy so the fallback policy can decide whether to retry. Mirrors
 * the classifier in `llm/provider.ts:306-316` that runs for non-stream
 * flows. Anthropic's AI SDK provider surfaces rate limits and
 * overload as messages like "rate_limit" / "overloaded" / 429 / 529.
 */
function classifyStreamError(err: unknown): LlmProviderError | null {
  if (err instanceof LlmProviderError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("rate_limit") || msg.includes("429")) {
    return new LlmProviderError("rate_limit", msg);
  }
  if (msg.includes("overloaded") || msg.includes("529")) {
    return new LlmProviderError("overloaded", msg);
  }
  if (msg.includes("context_length") || msg.includes("too many tokens")) {
    return new LlmProviderError("context_length_exceeded", msg);
  }
  return null;
}

function shouldFallback(err: LlmProviderError): boolean {
  return (
    err.kind === "rate_limit" || err.kind === "overloaded" || err.kind === "context_length_exceeded"
  );
}

function readStepUsage(step: {
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    inputTokenDetails?: {
      cacheReadTokens?: number | undefined;
      cacheWriteTokens?: number | undefined;
    };
  };
  providerMetadata?: Record<string, unknown> | undefined;
}): StepUsage {
  const inputTokens = step.usage.inputTokens ?? 0;
  const outputTokens = step.usage.outputTokens ?? 0;
  let cacheReadTokens = step.usage.inputTokenDetails?.cacheReadTokens ?? 0;
  let cacheCreationTokens = step.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  // Anthropic surfaces cache tokens via providerMetadata.anthropic.usage
  // when the unified usage fields are unset. Prefer the flat fields and
  // fall back to provider metadata.
  const anthropic = step.providerMetadata?.anthropic as
    | { usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
    | undefined;
  if (!cacheReadTokens && anthropic?.usage?.cache_read_input_tokens) {
    cacheReadTokens = Number(anthropic.usage.cache_read_input_tokens);
  }
  if (!cacheCreationTokens && anthropic?.usage?.cache_creation_input_tokens) {
    cacheCreationTokens = Number(anthropic.usage.cache_creation_input_tokens);
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

export async function runLoop(p: RunLoopParams): Promise<RunLoopResult> {
  const events: TurnEvent[] = [];
  const budget = p.step_budget ?? DEFAULT_BUDGET;

  log.debug({
    module: "conversation",
    action: "loop.started",
    msg: "turn started",
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    has_user_message: Boolean(p.user_message),
    step_budget: budget,
    model_override: p.model_override ?? null,
  });

  const usageBefore = await monthlyUsage(p.tenant_id, p.db).catch(() => 0);

  if (p.user_message) {
    await appendMessage(p.db, p.tenant_id, p.conversation_id, "user", { text: p.user_message });
    events.push({ type: "message", role: "user", content: { text: p.user_message } });
  }

  // Draft state for the turn — tools mutate via ctx.setDraft, which
  // snapshots to conversation_drafts for audit/undo.
  let draft: DraftDocument = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  const ctx: ToolContext = {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: p.connector_id,
    workflow_id: p.workflow_id,
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
      const { appendSnapshot } = await import("./draft.ts");
      await appendSnapshot(p.tenant_id, p.conversation_id, next, p.db);
    },
  };

  const route = await resolveModelRoute(p.tenant_id, p.db);
  const effectiveModel = p.model_override ?? route.primary;

  // Pre-check budget. Worst case: `budget` steps × ~1 K output each +
  // the assembled prompt. Matches the envelope `callWithFallback`
  // used before A5.
  const currentUserText = p.user_message ?? "continue";
  const prompt = await assembleEnhancedPrompt(
    {
      tenant_id: p.tenant_id,
      flow: "converse",
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
      user_turns: [{ role: "user", content: currentUserText }],
      max_tokens: route.context_cap,
      model: effectiveModel,
      ...(p.user_memory ? { user_memory: p.user_memory } : {}),
    },
    p.db,
  );
  const estimated = prompt.token_counts.total + budget * 1024;
  try {
    await checkBudget(p.tenant_id, estimated, route.monthly_budget, p.db);
    const verdict = await checkAndDecrement(p.tenant_id, estimated, p.db);
    if (!verdict.ok) {
      throw new LlmQuotaExhausted("llm_quota_exhausted", {
        used: verdict.used,
        projected_tokens: verdict.projected_tokens,
        budget: verdict.budget,
        remaining: verdict.remaining,
      });
    }
  } catch (err) {
    if (err instanceof LlmQuotaExhausted) {
      await recordUsage(
        {
          tenant_id: p.tenant_id,
          flow: "converse",
          model: effectiveModel,
          prompt_tokens: prompt.token_counts.total,
          completion_tokens: 0,
          latency_ms: 0,
          result: "quota_exhausted",
          error: "llm_quota_exhausted",
        },
        p.db,
      );
      recordLlmQuotaExhausted({ tenant_id: p.tenant_id });
    }
    throw err;
  }

  const messages = await buildModelMessages(p.db, p.tenant_id, p.conversation_id, {
    conversationEnvelope: true,
    conversation_id: p.conversation_id,
  });

  const signals: TurnSignals = { step: 0, toolChain: Promise.resolve() };
  const tools = wrapTools(ctx, signals, events, p.db);

  /**
   * Run `streamText` once against `modelId`. Wired-in side-effects
   * (tool execution, DB writes, events) happen inside the tool
   * wrapper and `onStepFinish`; the caller only sees success or
   * error. Usage rows are written per-step with `modelId` as the
   * `model` column so fallback attempts show up as distinct rows.
   */
  async function runOnce(modelId: string): Promise<void> {
    let lastStepEnd = Date.now();
    // Rebuild messages every attempt so a fallback retry picks up any
    // tool calls that the failed primary already persisted.
    const attemptMessages = await buildModelMessages(p.db, p.tenant_id, p.conversation_id, {
      conversationEnvelope: true,
      conversation_id: p.conversation_id,
    });
    // The SDK wraps provider-level errors thrown from `doStream` inside
    // `AI_NoOutputGeneratedError` when no step was recorded, which hides
    // the original error kind our fallback classifier needs. `onError`
    // is the only place we can observe the raw error, so we capture it
    // here and re-throw it on drain failure. See
    // apps/engine/src/llm/errors.ts for our classification taxonomy.
    let capturedError: unknown;
    const result = streamText({
      model: resolveLanguageModel(route.provider, modelId),
      system: prompt.system,
      messages: attemptMessages,
      tools,
      toolChoice: "auto",
      stopWhen: [
        stepCountIs(budget),
        hasToolCall("ask_user_choice"),
        hasToolCall("ask_user_multi"),
        hasToolCall("ask_user_text"),
        hasToolCall("ask_user_form"),
        hasToolCall("ask_user_confirm"),
        // biome-ignore lint/suspicious/noExplicitAny: SDK StopCondition generic over variadic ToolSet; runtime contract matches.
        committedStopCondition as any,
      ],
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(Math.min(10 * 60_000, 30_000 * budget)),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "converse",
        metadata: {
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          provider: route.provider,
          model: modelId,
        },
      },
      onError: ({ error }) => {
        if (!capturedError) capturedError = error;
      },
      onStepFinish: async (step) => {
        const u = readStepUsage(step);
        const now = Date.now();
        const latency_ms = Math.max(0, now - lastStepEnd);
        lastStepEnd = now;
        await recordUsage(
          {
            tenant_id: p.tenant_id,
            flow: "converse",
            model: modelId,
            prompt_tokens: u.inputTokens,
            completion_tokens: u.outputTokens,
            cache_read_tokens: u.cacheReadTokens,
            cache_creation_tokens: u.cacheCreationTokens,
            latency_ms,
            result: "success",
          },
          p.db,
        );
        recordLlmTokens({
          tenant_id: p.tenant_id,
          model: modelId,
          flow: "converse",
          prompt_tokens: u.inputTokens,
          completion_tokens: u.outputTokens,
        });
        if (step.text && step.text.length > 0) {
          await appendMessage(p.db, p.tenant_id, p.conversation_id, "assistant", {
            text: step.text,
          });
          events.push({ type: "message", role: "assistant", content: { text: step.text } });
        }
      },
    });
    try {
      await result.finishReason;
    } catch (err) {
      // Prefer the original provider-level error captured via onError
      // so our fallback classifier can see `rate_limit`/`overloaded`.
      if (capturedError) throw capturedError;
      throw err;
    }
  }

  void messages; // messages rebuilt per-attempt inside runOnce
  try {
    await runOnce(effectiveModel);
  } catch (primaryErr) {
    const providerErr = classifyStreamError(primaryErr);
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    logger.warn({
      module: "llm",
      action: "converse.failed",
      msg: "streamText primary error",
      conversation_id: p.conversation_id,
      model: effectiveModel,
      kind: providerErr?.kind ?? "other",
      error: msg,
    });
    await recordUsage(
      {
        tenant_id: p.tenant_id,
        flow: "converse",
        model: effectiveModel,
        prompt_tokens: prompt.token_counts.total,
        completion_tokens: 0,
        latency_ms: 0,
        result: "error",
        error: msg,
      },
      p.db,
    );
    if (!providerErr || !shouldFallback(providerErr) || route.fallback === effectiveModel) {
      throw primaryErr;
    }
    logger.warn({
      module: "llm",
      action: "fallback.triggered",
      msg: "llm fallback engaged",
      flow: "converse",
      conversation_id: p.conversation_id,
      primary: effectiveModel,
      fallback: route.fallback,
      kind: providerErr.kind,
    });
    try {
      await runOnce(route.fallback);
    } catch (fbErr) {
      const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      logger.warn({
        module: "llm",
        action: "converse.failed",
        msg: "streamText fallback error",
        conversation_id: p.conversation_id,
        model: route.fallback,
        error: fbMsg,
      });
      await recordUsage(
        {
          tenant_id: p.tenant_id,
          flow: "converse",
          model: route.fallback,
          prompt_tokens: prompt.token_counts.total,
          completion_tokens: 0,
          latency_ms: 0,
          result: "error",
          error: fbMsg,
        },
        p.db,
      );
      throw fbErr;
    }
  }

  // Resolve final status.
  let status: RunLoopResult["status"] = "active";
  let committedWorkflowId: string | undefined;
  let pendingElicitationId: string | undefined;
  if (signals.committed) {
    status = "committed";
    committedWorkflowId = signals.committed.workflow_id;
    events.push({ type: "completed", status: "committed" });
  } else if (signals.pendingElicitation) {
    status = "awaiting_input";
    pendingElicitationId = signals.pendingElicitation.elicitation_id;
    events.push({ type: "completed", status: "awaiting_input" });
  } else {
    // Either budget exhausted or the model stopped with text only.
    const rows = await p.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, p.conversation_id))
      .limit(1);
    if (rows[0]?.status === "awaiting_input") {
      status = "awaiting_input";
    }
    if (signals.step >= budget && !signals.pendingElicitation) {
      log.warn({
        module: "conversation",
        action: "loop.budget_exhausted",
        msg: "turn stopped without done/elicitation/commit (budget reached)",
        conversation_id: p.conversation_id,
        step_budget: budget,
      });
    }
    events.push({ type: "completed", status: "active" });
  }

  // Attach turn usage to every `completed` frame (sk status-line
  // reads `turn_tokens` + `remaining_monthly_budget_tokens`).
  const usageAfter = await monthlyUsage(p.tenant_id, p.db).catch(() => usageBefore);
  const turnTokens = Math.max(0, usageAfter - usageBefore);
  const remaining =
    route.monthly_budget != null ? Math.max(0, route.monthly_budget - usageAfter) : null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && ev.type === "completed") {
      events[i] = {
        ...ev,
        usage: { turn_tokens: turnTokens, remaining_monthly_budget_tokens: remaining },
      };
    }
  }

  const out: RunLoopResult = { events, status };
  if (committedWorkflowId) out.committed_workflow_id = committedWorkflowId;
  if (pendingElicitationId) out.pending_elicitation_id = pendingElicitationId;
  return out;
}
