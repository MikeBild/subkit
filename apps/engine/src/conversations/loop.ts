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
import { and, desc, eq } from "drizzle-orm";
import { recordToolPolicyConfirmationRequired } from "../audit/recorders/index.ts";
import type { Db } from "../db/client.ts";
import {
  connectorEndpointSchemas,
  conversationAttachments,
  conversations,
  conversationToolCalls,
  executions,
} from "../db/schema/index.ts";
import { checkAndDecrement, checkBudget, monthlyUsage, recordUsage } from "../llm/budgets.ts";
import { renderAuthoringContextBlock } from "../llm/core/authoring-context-block.ts";
import { splitPromptIntoBlocks, toSystemMessages } from "../llm/core/cache-blocks.ts";
import { assembleEnhancedPrompt, detectIntentSkills } from "../llm/core/context-assembler.ts";
import { resolveModelRoute, resolveLanguageModel as resolveSdkModel } from "../llm/core/invoke.ts";
import { LlmQuotaExhausted } from "../llm/errors.ts";
import { createMockLanguageModel } from "../llm/mock-stream.ts";
import { runOutputGuard } from "../llm/output-guard/index.ts";
import {
  classifyProviderError,
  isFallbackEligible,
  toLlmProviderError,
} from "../llm/provider-errors.ts";
import { countModelMessagesTokens } from "../llm/tokens.ts";
import { log, logger } from "../logging/logger.ts";
import { recordLlmQuotaExhausted, recordLlmTokens } from "../observability/instrumentation.ts";
import {
  CONVERSATION_CANCELLED_REASON,
  mergeAbortSignals,
  registerConversationAbort,
  unregisterConversationAbort,
} from "./abort.ts";
import { startNewWorkflowDraft } from "./authoring-state.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import { setElicitationParentMessage } from "./elicitations.ts";
import { EventSink } from "./event-sink.ts";
import { detectUserIntent, inferStateDrivenFollowUpTool } from "./intent-detector.ts";
import {
  appendMessage,
  buildModelMessages,
  buildUserContentParts,
  setToolCallParentMessage,
} from "./persist.ts";
import type { ToolContext } from "./tools/index.ts";
import { type TurnSignals, wrapTools } from "./tools/sdk-wrap.ts";
import { resolveExecutionMode } from "./tools/tool-policies.ts";
import { synthesizeFallbackMessage, turnLoopBudgetStopCondition } from "./turn-helpers.ts";
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
  /**
   * Surface the conversation is running on. Selects the per-surface
   * system-prompt variant (terse for sk_headless, conversational for
   * sk_interactive, machine-readable for mcp, etc).
   */
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web";
  /**
   * Live emitter — invoked synchronously every time the loop pushes a
   * TurnEvent. Used by the HTTP SSE route and MCP progress bridge to
   * stream frames as they occur rather than waiting for the loop to
   * complete. The same events are also buffered in the return value
   * for replay / persistence.
   */
  onEvent?: (ev: TurnEvent) => void;
  /**
   * Real runtime context the model must quote verbatim instead of
   * inventing placeholders. Threaded into `assembleEnhancedPrompt` and
   * rendered as the RUNTIME CONTEXT system-prompt block. See
   * `llm/runtime-context.ts`.
   */
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
  /**
   * Client-supplied permission mode for this turn. Overrides the
   * per-tool policy matrix: "auto" skips confirmations on
   * non-dangerous tools, "ask" confirms every tenant_write, "plan"
   * is surfaced to the client identically to "ask". See
   * `tool-policies.ts#resolveToolMode` for the full precedence order.
   */
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
}

export interface RunLoopResult {
  events: TurnEvent[];
  status: "awaiting_input" | "committed" | "active" | "abandoned" | "exhausted";
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
async function resolveLanguageModel(provider: string, modelId: string) {
  if (provider === "mock") return createMockLanguageModel(modelId);
  // biome-ignore lint/suspicious/noExplicitAny: LlmProviderKind is broader
  return await resolveSdkModel(provider as any, modelId);
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

/**
 * Stop after any tool returns a pause payload. This is required for
 * policy-gated confirm-before-execution flows where the wrapper emits
 * an `ask_user_confirm` elicitation without the model explicitly
 * calling `ask_user_confirm` as a tool in the same step.
 */
const pausedStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<{
    toolResults: ReadonlyArray<{ output?: unknown }>;
  }>;
}): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((result) => {
    const output = result.output;
    return !!output && typeof output === "object" && "pause" in (output as Record<string, unknown>);
  });
};

interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  if (err instanceof Error) return /abort|cancel/i.test(err.message);
  return /abort|cancel/i.test(String(err));
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
  // Live event streaming: callers that want real-time frames pass
  // `onEvent`. Buffered replay stays available via `result.events`.
  const sink = new EventSink(p.onEvent);
  // Proxy-backed view over the EventSink — existing `events.push(ev)`
  // call-sites continue to work, but every push is also emitted live
  // via `p.onEvent` when supplied.
  const events: TurnEvent[] = sink.asArrayProxy();
  const budget = p.step_budget ?? DEFAULT_BUDGET;
  const turnAbortCtrl = registerConversationAbort(p.conversation_id);

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

  const detectedIntent = detectUserIntent(p.user_message);
  let workflowIdForTurn = p.workflow_id;

  // Draft state for the turn — tools mutate via ctx.setDraft, which
  // snapshots to conversation_drafts for audit/undo.
  let draft: DraftDocument = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  const hasBoundSavedWorkflow =
    workflowIdForTurn !== null ||
    draft.summary?.active_target.kind === "workflow" ||
    draft.summary?.persisted_resources.some((resource) => resource.kind === "workflow") === true;
  if (detectedIntent.startNewWorkflow === true && hasBoundSavedWorkflow) {
    // An explicit "create a workflow" request starts a fresh draft.
    // Keeping the previous saved workflow target here would turn the
    // next commit into an in-place update of the old workflow.
    draft = startNewWorkflowDraft(draft);
    workflowIdForTurn = null;
    await p.db
      .update(conversations)
      .set({ target_workflow_id: null, updated_at: new Date() })
      .where(
        and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)),
      );
    await appendSnapshot(p.tenant_id, p.conversation_id, draft, p.db);
  }
  const { EngineClient } = await import("../engine-client/index.ts");
  const ctx: ToolContext = {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: p.connector_id,
    workflow_id: workflowIdForTurn,
    permission_mode: p.permission_mode ?? null,
    engineClient: new EngineClient({
      tenant_id: p.tenant_id,
      actor_id: p.actor_id,
      // The loop is driven by HTTP/MCP requests whose principal may be a
      // human user (session) or a system_account (API key). We don't
      // plumb the principal kind through RunLoopParams yet — default to
      // `user` when actor_id is set (chat sessions), `system` otherwise.
      // API-key driven conversations get the correct "system_account"
      // actor_type once the principal is threaded through, tracked as a
      // follow-up.
      actor_type: p.actor_id ? "user" : "system",
      db: p.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
      await appendSnapshot(p.tenant_id, p.conversation_id, next, p.db);
    },
    abortSignal: turnAbortCtrl.signal,
    recentUserMessage: p.user_message ?? null,
  };

  const route = await resolveModelRoute(p.tenant_id, p.db);
  const effectiveModel = p.model_override ?? route.primary;

  // Pre-check budget. Worst case: `budget` steps × ~1 K output each +
  // the assembled prompt. Matches the envelope `callWithFallback`
  // used before A5.
  const currentUserText = p.user_message ?? "continue";
  // Thread loaded skills from the conversation row into the prompt so
  // on-demand knowledge from `load_skill(slug)` actually reaches the
  // model. Also thread `surface` so per-surface prompt variants fire.
  const loadedSkillsRowForPrompt = await p.db
    .select({ loaded_skills: conversations.loaded_skills })
    .from(conversations)
    .where(eq(conversations.id, p.conversation_id))
    .limit(1);
  const explicitSkillSlugs = (loadedSkillsRowForPrompt[0]?.loaded_skills ?? []) as string[];

  // Auto-load skills based on conversation context — attachment MIME
  // types, recent execution failures, and target workflow presence.
  // Deterministic keyword match against `skills.trigger_keywords`.
  const attachmentMimeRows = await p.db
    .select({ content_type: conversationAttachments.content_type })
    .from(conversationAttachments)
    .where(eq(conversationAttachments.conversation_id, p.conversation_id));
  const attachmentMimeTypes = attachmentMimeRows
    .map((r) => r.content_type)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  let hasFailedExecution = false;
  if (workflowIdForTurn) {
    const failed = await p.db
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.workflow_id, workflowIdForTurn))
      .limit(5);
    hasFailedExecution = failed.length > 0; // any prior execution counts as feedback context
  }
  const intentSkillSlugs = await detectIntentSkills(
    p.tenant_id,
    {
      attachmentMimeTypes,
      userMessage: currentUserText,
      hasFailedExecution,
      hasMultipleConnectors: false,
    },
    p.db,
  );
  const loadedSkillSlugs = [...new Set([...explicitSkillSlugs, ...intentSkillSlugs])];

  // Surface document-analysis registry summary for the active connector
  // so the model sees what was extracted without needing to re-read it.
  let documentAnalysisSummary: {
    source: string;
    confidence: number;
    endpoint_count: number;
    sample_endpoints: Array<{ method: string; path: string }>;
  } | null = null;
  const activeConnectorId =
    p.connector_id ??
    (
      await p.db
        .select({ target_connector_id: conversations.target_connector_id })
        .from(conversations)
        .where(eq(conversations.id, p.conversation_id))
        .limit(1)
    )[0]?.target_connector_id ??
    null;
  if (activeConnectorId) {
    const epRows = await p.db
      .select({
        method: connectorEndpointSchemas.method,
        path: connectorEndpointSchemas.path,
        source: connectorEndpointSchemas.source,
        confidence: connectorEndpointSchemas.confidence,
      })
      .from(connectorEndpointSchemas)
      .where(eq(connectorEndpointSchemas.connector_id, activeConnectorId))
      .limit(50);
    if (epRows.length > 0) {
      const source = epRows[0]!.source;
      const confidence = epRows[0]!.confidence;
      documentAnalysisSummary = {
        source,
        confidence,
        endpoint_count: epRows.length,
        sample_endpoints: epRows.map((r) => ({ method: r.method, path: r.path })),
      };
    }
  }
  const authoringContext = renderAuthoringContextBlock({
    draft,
    user_message: currentUserText,
    document_analysis: documentAnalysisSummary,
  });
  const authoringHint = draft.summary
    ? {
        mode: draft.summary.mode,
        stage: draft.summary.stage,
        lifecycle_state: draft.summary.lifecycle_state,
        active_target: {
          kind: draft.summary.active_target.kind,
          lifecycle_state: draft.summary.active_target.lifecycle_state,
        },
        blocked_by: [...draft.summary.blocked_by],
        next_required_action: draft.summary.next_required_action,
        next_suggested_tool: draft.summary.next_suggested_tool,
        checkpoints: [...draft.summary.checkpoints],
        latest_execution: draft.summary.latest_execution
          ? {
              diagnosis_available: draft.summary.latest_execution.diagnosis_available,
            }
          : null,
        latest_diagnosis: draft.summary.latest_diagnosis
          ? {
              reason: draft.summary.latest_diagnosis.reason,
            }
          : null,
      }
    : undefined;
  // When the last dry-run surfaced warnings (unresolved identifiers, rate
  // limits, etc.), fold them into prior_failures so the next turn's prompt
  // carries them as structured context — the LLM sees what to fix without
  // the user having to quote the warning text back.
  const previewWarnings = draft.latest_preview?.warnings ?? [];
  const priorFailuresFromPreview =
    previewWarnings.length > 0
      ? previewWarnings.slice(0, 10).map((w) => ({
          step_id: w.step_key ?? "preview",
          error: `dry-run warning ${w.code ?? "unknown"}: ${w.message ?? ""}`,
        }))
      : [];

  // Fold `next_best_actions` from the most recent failing tool calls
  // into prior_failures so the agent's prompt carries explicit
  // guidance on what to do next. Without this, a tool that returned
  // `{ ok:false, error_code: "credential_required",
  //    next_best_actions: ["ask_user_form"] }` only reaches the LLM
  // via the truncated tool-result message — putting the action list
  // in prior_failures keeps it in the high-priority section.
  const recentToolCalls = await p.db
    .select({
      tool: conversationToolCalls.tool,
      output: conversationToolCalls.output,
      created_at: conversationToolCalls.created_at,
    })
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.conversation_id, p.conversation_id))
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(8);
  const priorFailuresFromTools: Array<{ step_id: string; error: string }> = [];
  for (const row of recentToolCalls) {
    const output = row.output as Record<string, unknown> | null;
    if (!output || typeof output !== "object") continue;
    if (output.ok === false || typeof output.error_code === "string") {
      const nbaRaw = output.next_best_actions;
      const nba = Array.isArray(nbaRaw)
        ? nbaRaw.filter((x): x is string => typeof x === "string")
        : [];
      const code = typeof output.error_code === "string" ? output.error_code : "tool_failed";
      const message =
        typeof output.message === "string"
          ? output.message
          : typeof (output as { error?: unknown }).error === "string"
            ? (output as { error: string }).error
            : "";
      const nbaSuffix = nba.length > 0 ? ` — try next: ${nba.join(", ")}` : "";
      priorFailuresFromTools.push({
        step_id: row.tool,
        error: `${row.tool} failed (${code}): ${message}${nbaSuffix}`,
      });
      if (priorFailuresFromTools.length >= 5) break;
    }
  }
  const combinedPriorFailures = [...priorFailuresFromPreview, ...priorFailuresFromTools];

  const prompt = await assembleEnhancedPrompt(
    {
      tenant_id: p.tenant_id,
      flow: "converse",
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      ...(workflowIdForTurn ? { workflow_id: workflowIdForTurn } : {}),
      user_turns: await (async () => {
        const parts = await buildUserContentParts(
          p.db,
          p.conversation_id,
          currentUserText,
          route.provider,
        );
        return [
          Array.isArray(parts)
            ? { role: "user" as const, content: currentUserText, content_parts: parts }
            : { role: "user" as const, content: currentUserText },
        ];
      })(),
      max_tokens: route.context_cap,
      model: effectiveModel,
      ...(p.user_memory ? { user_memory: p.user_memory } : {}),
      ...(loadedSkillSlugs.length > 0 ? { loaded_skill_slugs: loadedSkillSlugs } : {}),
      ...(p.surface ? { surface: p.surface } : {}),
      ...(authoringContext ? { authoring_context: authoringContext } : {}),
      ...(authoringHint ? { authoring_hint: authoringHint } : {}),
      ...(combinedPriorFailures.length > 0 ? { prior_failures: combinedPriorFailures } : {}),
      ...(p.runtime_context
        ? {
            runtime_context: {
              ...(p.runtime_context.engine_url ? { engine_url: p.runtime_context.engine_url } : {}),
              ...(p.runtime_context.tenant_slug
                ? { tenant_slug: p.runtime_context.tenant_slug }
                : {}),
              ...(p.runtime_context.actor_email
                ? { actor_email: p.runtime_context.actor_email }
                : {}),
              ...(p.runtime_context.actor_role ? { actor_role: p.runtime_context.actor_role } : {}),
              ...(p.surface ? { surface: p.surface } : {}),
              ...(p.permission_mode ? { permission_mode: p.permission_mode } : {}),
            },
          }
        : p.permission_mode
          ? { runtime_context: { permission_mode: p.permission_mode } }
          : {}),
    },
    p.db,
  );
  const messages = await buildModelMessages(p.db, p.tenant_id, p.conversation_id, {
    conversationEnvelope: true,
    conversation_id: p.conversation_id,
  });
  const messageTokens = countModelMessagesTokens(messages);
  const estimatedPromptTokens = prompt.token_counts.total + messageTokens;
  const estimated = estimatedPromptTokens + budget * 1024;
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
          prompt_tokens: estimatedPromptTokens,
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

  // Load the conversation's `loaded_skills` + `tool_policies` so
  // skill-gated tools are filtered out until the matching
  // `load_skill(slug)` is called and policy-gated tools see the
  // right pre-execution mode.
  const skillAndPolicyRow = await p.db
    .select({
      loaded_skills: conversations.loaded_skills,
      tool_policies: conversations.tool_policies,
    })
    .from(conversations)
    .where(eq(conversations.id, p.conversation_id))
    .limit(1);
  const persistedLoadedSkills = (skillAndPolicyRow[0]?.loaded_skills ?? []) as string[];
  // Auto-load the canonical authoring skills so the palette exposes
  // both the connector and workflow tool sets from turn one. The user's
  // first message could go either way ("create a connector for foo" /
  // "build a workflow that bars"); exposing both sets up front avoids
  // the dead-end where the LLM has to call `load_skill` twice before
  // it can do anything (and avoids the 00b93a52 failure where the
  // model said "tool not in palette" and asked the user to restart).
  // The skill BODIES are still pulled into the prompt only when needed
  // (via `detectIntentSkills`) — this auto-load only shapes the
  // PALETTE, not the prompt budget.
  const AUTO_LOADED_AUTHORING_SKILLS: ReadonlyArray<string> = [
    "connector-creation-guidance",
    "workflow-authoring",
  ];
  const loadedSkills = [...new Set([...persistedLoadedSkills, ...AUTO_LOADED_AUTHORING_SKILLS])];
  const loopToolPolicies = (skillAndPolicyRow[0]?.tool_policies ?? {}) as Record<
    string,
    "no_confirm" | "confirm_before_execution" | "confirm_after_execution"
  >;
  logger.debug({
    module: "conversation_palette",
    action: "palette.resolved",
    msg: "resolved authoring palette",
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    loaded_skills: loadedSkills,
    persisted_skills_count: persistedLoadedSkills.length,
  });

  const signals: TurnSignals = {
    step: 0,
    toolChain: Promise.resolve(),
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    totalLoopWarnings: 0,
    lastAssistantText: "",
  };
  const wrappedTools = wrapTools(
    ctx,
    signals,
    events,
    p.db,
    loadedSkills,
    loopToolPolicies,
    p.permission_mode ?? null,
  );
  logger.debug({
    module: "conversation_palette",
    action: "palette.tools_resolved",
    msg: "wrapped tool count",
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    loaded_skills: loadedSkills,
    tools_count: Object.keys(wrappedTools).length,
  });

  // Pre-dispatch policy resolver — consults `tool-policies.ts` for
  // every LLM-emitted tool call BEFORE we hand it to the wrapped
  // execute. The resolver decides whether the call needs to pause
  // for human confirmation; the resolution is logged as a structured
  // event so operators / observability see the decision per-call.
  // The wrapped tool's own confirmation gate (sdk-wrap.ts) is the
  // mechanism that actually pauses the loop — this hook is the single
  // canonical resolver the loop owns.
  const tools: typeof wrappedTools = {};
  for (const [name, wrapped] of Object.entries(wrappedTools)) {
    // biome-ignore lint/suspicious/noExplicitAny: SDK Tool generic doesn't reconcile with our pre-flight wrapper.
    const innerExecute = (wrapped as unknown as { execute: (...args: any[]) => any }).execute;
    tools[name] = {
      ...wrapped,
      // biome-ignore lint/suspicious/noExplicitAny: pre-flight wrapper preserves the SDK's execute signature.
      execute: async (rawArgs: Record<string, unknown>, options: any) => {
        const resolvedEnv =
          typeof (rawArgs as { environment?: unknown }).environment === "string"
            ? (rawArgs as { environment: string }).environment
            : undefined;
        const resolved = resolveExecutionMode(name, rawArgs, {
          tenant_id: p.tenant_id,
          ...(resolvedEnv ? { environment: resolvedEnv } : {}),
        });
        logger.debug({
          module: "conversation_loop",
          action: "tool_policy.resolved",
          msg: "resolved tool execution mode",
          conversation_id: p.conversation_id,
          tenant_id: p.tenant_id,
          tool: name,
          mode: resolved.mode,
          confirmation_kind: resolved.confirmationKind,
          reason: resolved.reason,
        });
        // Wave 4: every confirmation pause lands an audit row so
        // operators can see policy decisions without scraping debug
        // logs. Best-effort — a failed audit write must not block tool
        // dispatch (`recordToolPolicyConfirmationRequired` is async,
        // but we don't await on the hot path beyond the helper's own
        // resilience to insert errors).
        if (resolved.mode === "confirm_before_execution") {
          await recordToolPolicyConfirmationRequired({
            tenant_id: p.tenant_id,
            actor_id: p.actor_id,
            executor: p.db,
            conversation_id: p.conversation_id,
            tool: name,
            mode: resolved.mode,
            confirmation_kind: resolved.confirmationKind,
            resolver_reason: resolved.reason,
            ...(resolvedEnv !== undefined ? { environment: resolvedEnv } : {}),
          }).catch((err: unknown) => {
            logger.warn({
              module: "conversation_loop",
              action: "tool_policy.audit_failed",
              msg: "failed to record tool_policy.confirmation_required audit",
              conversation_id: p.conversation_id,
              tool: name,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        return innerExecute(rawArgs, options);
      },
    } as typeof wrapped;
  }

  // Steer toolChoice from explicit user intent. Without this, the model
  // sees "auto" and can decide to just narrate ("the workflow already
  // filters correctly") without actually calling the tool — exactly the
  // hallucination reported in session f44bf9b4. We only force a tool when
  // (a) the detector sees a strong run-intent verb in any supported
  // language and (b) that tool actually exists in the palette this turn.
  const stateDrivenTool = inferStateDrivenFollowUpTool({
    latestUserText: p.user_message,
    permission_mode: p.permission_mode ?? null,
    summary: draft.summary,
  });
  const preferredTool =
    detectedIntent.forceTool && tools[detectedIntent.forceTool]
      ? detectedIntent.forceTool
      : stateDrivenTool && tools[stateDrivenTool]
        ? stateDrivenTool
        : null;
  const forceNoTools = detectedIntent.forceNoTools === true;
  if (preferredTool) {
    logger.debug({
      module: "conversation",
      action: "loop.intent.force_tool",
      msg: "steering toolChoice from user intent",
      conversation_id: p.conversation_id,
      forced_tool: preferredTool,
      reason:
        preferredTool === stateDrivenTool && !detectedIntent.forceTool
          ? "state_driven_follow_up_tool"
          : detectedIntent.reason,
    });
  }
  if (forceNoTools) {
    logger.debug({
      module: "conversation",
      action: "loop.intent.no_tools",
      msg: "pinning toolChoice to none — enumeration answer from snapshot",
      conversation_id: p.conversation_id,
      reason: detectedIntent.reason,
    });
  }

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
    const resolvedModel = await resolveLanguageModel(route.provider, modelId);
    const streamAbortSignal = mergeAbortSignals([
      turnAbortCtrl.signal,
      AbortSignal.timeout(Math.min(10 * 60_000, 30_000 * budget)),
    ]);
    // Cache-hint wiring: split the assembled prompt into a stable head
    // (base prompt + skills + tenant snapshot) and a volatile tail
    // (user memory + prior failures + authoring context) and attach
    // `cacheControl: { type: "ephemeral", ttl: "1h" }` to the head so
    // Anthropic / Vertex (Claude) can serve it from cache on
    // subsequent turns. Providers that don't understand the hint
    // ignore it. Enabled unconditionally for Claude models — the flag
    // on ModelRoute gates per-tenant opt-out if needed.
    const cacheSupported =
      (route.provider === "anthropic" ||
        route.provider === "vertex" ||
        route.provider === "bedrock" ||
        route.provider === "gateway") &&
      /claude/i.test(modelId);
    const cacheBlocks = splitPromptIntoBlocks(prompt, "converse");
    // The converse flow always opts into caching when the provider
    // supports it — the per-tenant `enable_prompt_cache` setting still
    // gates the one-shot flows (generate / repair / extract) via
    // invoke.ts, but an interactive authoring loop benefits too much
    // from cache hits to stay off by default.
    const systemMessages = toSystemMessages(cacheBlocks, {
      enabled: cacheSupported,
      ttl: "1h",
    });
    const result = streamText({
      model: resolvedModel,
      system: systemMessages,
      messages: attemptMessages,
      tools,
      toolChoice: preferredTool
        ? { type: "tool" as const, toolName: preferredTool }
        : forceNoTools
          ? "none"
          : "auto",
      // Disable parallel tool calls on Anthropic. The model used to
      // emit 5+ run_workflow calls in one turn ("starte mit übermorgen"
      // → 5 parallel run_workflow tool_use blocks, each producing its
      // own confirm_before_execution elicitation, each contributing a
      // loop-warning, all stopping with the synthesised "I stopped this
      // turn early" fallback). The skill body says "ONE STATE-CHANGING
      // TOOL PER TURN" but the model violated it because the AI SDK
      // happily ran every tool_use block the model emitted in a single
      // step. Disabling at the provider layer enforces it cleanly:
      // Anthropic returns a single tool_use per assistant turn.
      ...(cacheSupported
        ? { providerOptions: { anthropic: { disableParallelToolUse: true } } }
        : {}),
      stopWhen: [
        stepCountIs(budget),
        hasToolCall("ask_user_choice"),
        hasToolCall("ask_user_multi"),
        hasToolCall("ask_user_text"),
        hasToolCall("ask_user_form"),
        hasToolCall("cannot_help"),
        // biome-ignore lint/suspicious/noExplicitAny: SDK StopCondition generic over variadic ToolSet; runtime contract matches.
        pausedStopCondition as any,
        // biome-ignore lint/suspicious/noExplicitAny: SDK StopCondition generic over variadic ToolSet; runtime contract matches.
        committedStopCondition as any,
        // biome-ignore lint/suspicious/noExplicitAny: SDK StopCondition generic over variadic ToolSet; runtime contract matches.
        turnLoopBudgetStopCondition as any,
      ],
      maxRetries: 0,
      abortSignal: streamAbortSignal,
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
        // Always insert an assistant message when the step produced text
        // OR when the wrapper recorded children (tool calls, elicitations)
        // that need a causal anchor in the timeline. Empty assistant
        // rows act as the parent for tool-only steps so the read path
        // can render those tool calls in chronological position.
        const hasText = !!step.text && step.text.length > 0;
        const hasPendingChildren =
          signals.pendingChildToolCallIds.length > 0 ||
          signals.pendingChildElicitationIds.length > 0;
        if (hasText || hasPendingChildren) {
          // Pass every assistant text block through the grounded-output
          // guard. In `soft` (default) mode the guard logs violations
          // and rewrites placeholder fragments in place; in `hard`
          // mode (CI / scenario tests) it throws LlmOutputViolation
          // which propagates out of streamText. The persisted message
          // carries the (possibly rewritten) text plus the violation
          // list so replay tests + the capability-gap analytics can
          // read them back without re-scanning.
          const guarded = hasText
            ? runOutputGuard(step.text, {
                ...(p.runtime_context?.engine_url
                  ? { engine_url: p.runtime_context.engine_url }
                  : {}),
                ...(p.runtime_context?.tenant_slug
                  ? { tenant_slug: p.runtime_context.tenant_slug }
                  : {}),
              })
            : { text: "", violations: [] };
          const assistantMessageId = await appendMessage(
            p.db,
            p.tenant_id,
            p.conversation_id,
            "assistant",
            {
              text: guarded.text,
              ...(guarded.violations.length > 0
                ? {
                    _violations: guarded.violations.map((v) => ({
                      kind: v.kind,
                      message: v.message,
                    })),
                  }
                : {}),
            },
          );
          // Back-fill parent_message_id on every child row created during
          // this step so the read path can interleave them under this
          // assistant message in chronological order.
          await setToolCallParentMessage(p.db, signals.pendingChildToolCallIds, assistantMessageId);
          await setElicitationParentMessage(
            p.db,
            signals.pendingChildElicitationIds,
            assistantMessageId,
          );
          signals.pendingChildToolCallIds = [];
          signals.pendingChildElicitationIds = [];
          if (hasText) {
            signals.lastAssistantText = guarded.text;
            events.push({
              type: "message",
              role: "assistant",
              content: { text: guarded.text },
              id: assistantMessageId,
              parent_message_id: assistantMessageId,
            });
          }
        }
      },
    });
    try {
      // Drain the text stream so we can emit `text_delta` events as
      // assistant tokens arrive. The onStepFinish callback still runs
      // after the stream completes and appends the full assistant
      // message — text_delta is for live rendering, `message` is the
      // persisted record.
      try {
        for await (const chunk of result.textStream) {
          if (chunk.length > 0) events.push({ type: "text_delta", text: chunk });
        }
      } catch {
        // Drain errors surface via onError/capturedError below; ignore here.
      }
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
    let cancelled = false;
    try {
      await runOnce(effectiveModel);
    } catch (primaryErr) {
      if (turnAbortCtrl.signal.aborted && isAbortError(primaryErr)) {
        cancelled = true;
      } else {
        const providerKind = classifyProviderError(primaryErr);
        const providerErr = providerKind === "other" ? null : toLlmProviderError(primaryErr);
        const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        logger.warn({
          module: "llm",
          action: "converse.failed",
          msg: "streamText primary error",
          conversation_id: p.conversation_id,
          model: effectiveModel,
          kind: providerErr?.kind ?? providerKind,
          error: msg,
        });
        await recordUsage(
          {
            tenant_id: p.tenant_id,
            flow: "converse",
            model: effectiveModel,
            prompt_tokens: estimatedPromptTokens,
            completion_tokens: 0,
            latency_ms: 0,
            result: "error",
            error: msg,
          },
          p.db,
        );
        const sameProviderQuota =
          providerErr?.kind === "quota_exhausted" && route.fallback_provider === route.provider;
        if (
          !providerErr ||
          !isFallbackEligible(primaryErr) ||
          route.fallback === effectiveModel ||
          sameProviderQuota
        ) {
          throw providerErr ?? primaryErr;
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
          if (turnAbortCtrl.signal.aborted && isAbortError(fbErr)) {
            cancelled = true;
          } else {
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
                prompt_tokens: estimatedPromptTokens,
                completion_tokens: 0,
                latency_ms: 0,
                result: "error",
                error: fbMsg,
              },
              p.db,
            );
            const typedFallbackErr =
              classifyProviderError(fbErr) === "other" ? null : toLlmProviderError(fbErr);
            throw typedFallbackErr ?? fbErr;
          }
        }
      }
    }

    // Empty-text fallback — when the turn finishes without the model
    // emitting any assistant prose (e.g. after the loop-guard short-
    // circuited every subsequent tool attempt), synthesise a short
    // visible message from the collected tool results. Prior behaviour
    // rendered assistant_text:"" which surfaced as silence in the CLI
    // (observed in session 4e6696e3). A visible line is always better
    // than silence.
    if (
      !signals.lastAssistantText &&
      !signals.pendingElicitation &&
      !signals.committed &&
      !turnAbortCtrl.signal.aborted
    ) {
      const synthetic = synthesizeFallbackMessage({
        events,
        loopWarnings: signals.totalLoopWarnings,
      });
      if (synthetic) {
        const fallbackMessageId = await appendMessage(
          p.db,
          p.tenant_id,
          p.conversation_id,
          "assistant",
          { text: synthetic, _synthetic: true, _reason: "empty_turn_fallback" },
        );
        events.push({
          type: "message",
          role: "assistant",
          content: { text: synthetic },
          id: fallbackMessageId,
          parent_message_id: fallbackMessageId,
        });
        signals.lastAssistantText = synthetic;
        log.warn({
          module: "conversation",
          action: "loop.empty_text_synthesized",
          msg: "turn ended with no assistant text — synthesised fallback from tool results",
          conversation_id: p.conversation_id,
          loop_warnings: signals.totalLoopWarnings,
        });
      }
    }

    // Resolve final status.
    let status: RunLoopResult["status"] = "active";
    let committedWorkflowId: string | undefined;
    let pendingElicitationId: string | undefined;
    const rows = await p.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, p.conversation_id))
      .limit(1);
    const persistedStatus = rows[0]?.status ?? null;
    const conversationCancelled =
      cancelled ||
      persistedStatus === "abandoned" ||
      turnAbortCtrl.signal.reason === CONVERSATION_CANCELLED_REASON;
    if (conversationCancelled) {
      status = "abandoned";
      events.push({ type: "completed", status: "abandoned" });
    } else if (signals.committed) {
      status = "committed";
      committedWorkflowId = signals.committed.workflow_id;
      events.push({ type: "completed", status: "committed" });
    } else if (signals.pendingElicitation || persistedStatus === "awaiting_input") {
      status = "awaiting_input";
      pendingElicitationId = signals.pendingElicitation?.elicitation_id;
      events.push({ type: "completed", status: "awaiting_input" });
    } else {
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
  } finally {
    unregisterConversationAbort(p.conversation_id, turnAbortCtrl);
  }
}
