// Conversation tool-use loop, SDK-driven.
//
// The loop hands turn execution to `streamText` with our tool palette
// wrapped via `tool()`. Stop conditions halt the run on step-count
// exhaustion, `request_human_approval` (pause for operator), or a
// `save_workflow_draft` that returned a `committed_workflow_id`. Each tool's
// side-effects (DB row inserts, event emission, logging, approval
// creation) happen inside the `sdk-wrap` adapter — this file's job is
// composing the call, mapping callbacks into DB writes + events, and
// resolving the final per-turn status.

import { hasToolCall, stepCountIs, streamText, type ToolSet } from "ai";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import {
  connectorEndpointSchemas,
  conversations,
  conversationToolCalls,
  executions,
  fileLinks,
  files,
} from "../db/schema/index.ts";
import {
  actorFields,
  checkAndDecrement,
  checkBudget,
  contextCapFor,
  countModelMessagesTokens,
  monthlyUsage,
  recordUsage,
} from "../llm/accounting/index.ts";
import { renderAuthoringContextBlock } from "../llm/core/authoring-context-block.ts";
import { splitPromptIntoBlocks, toSystemMessages } from "../llm/core/cache-blocks.ts";
import {
  assembleEnhancedPrompt,
  countSkillTokens,
  detectIntentSkills,
} from "../llm/core/context-assembler.ts";
import { resolveModelRoute } from "../llm/core/invoke.ts";
import { anthropicWebSearchApplies, buildAnthropicWebSearchTool } from "../llm/core/model-init.ts";
import { repairToolCall as repairToolCallHandler } from "../llm/core/repair-tool-call.ts";
import {
  prepareStep as routerPrepareStep,
  type StepRouterSignals,
  supportsExtendedThinking,
} from "../llm/core/step-router.ts";
import { resolveThinking } from "../llm/core/thinking-policy.ts";
import { type CriticArtifact, type CriticVerdict, runCritic } from "../llm/critic/index.ts";
import { LlmContextTooLarge, LlmQuotaExhausted } from "../llm/errors.ts";
import { runOutputGuard, runOutputGuardStream } from "../llm/output-guard/index.ts";
import { createStreamScrubber } from "../llm/output-guard/stream-scrub.ts";
import {
  classifyProviderError,
  isFallbackEligible,
  toLlmProviderError,
} from "../llm/provider-errors.ts";
import { log, logger } from "../logging/logger.ts";
import {
  recordLlmQuotaExhausted,
  recordLlmTokens,
  recordToolHallucinatedAbsence,
} from "../observability/instrumentation.ts";
import { timePhase, timePhaseAsync } from "../observability/runtime-telemetry.ts";
import { isTracingActive } from "../observability/tracing.ts";
import { now } from "../utils/clock.ts";
import { mergeAbortSignals } from "./_internal/abort-merge.ts";
import { CONVERSATION_CANCELLED_REASON, isExpectedCancellation } from "./abort.ts";
import { resolveAttachmentSlugsInText } from "./attachments.ts";
import { expandPriorFailuresFromToolCalls } from "./authoring-critic/prior-failures.ts";
import { hasInProgressWorkflowDraft, startNewWorkflowDraft } from "./authoring-state.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import type { ElicitationBridge } from "./elicitation-bridge.ts";
import { createElicitation, setElicitationParentMessage } from "./elicitations.ts";
import { EventSink } from "./event-sink.ts";
import {
  detectMultiArtifactIntent,
  detectUserIntent,
  inferStateDrivenFollowUpTool,
} from "./intent-detector.ts";
import { RUN_VERB_RE } from "./intent-patterns.ts";
import { resolveInitialModel } from "./loop/authoring-intent.ts";
import {
  DEFAULT_BUDGET,
  MAX_REPAIRS_PER_TURN,
  resolveLanguageModel,
} from "./loop/model-resolver.ts";
import { applyRecency, parseLoadedSkills } from "./loop/skill-recency.ts";
import {
  committedStopCondition,
  noProgressRepairStopCondition,
  pausedStopCondition,
} from "./loop/stop-conditions.ts";
import { buildNextSuggestionFrame } from "./loop/suggest-next-emitter.ts";
import { detectToolHallucinatedAbsence } from "./loop/tool-not-available-guard.ts";
import { readStepUsage, stepPromptTokens, stepTotalTokens } from "./loop/usage.ts";
import {
  appendMessage,
  buildModelMessages,
  buildUserContentParts,
  setToolCallParentMessage,
  updateMessageContent,
} from "./persist.ts";
import { resolveScopeFactsForConversation } from "./scope-facts.ts";
import {
  autoloadForUserTurn,
  listBaselineSlugs,
  loadActivationCatalog,
  reaffirmLoadedForTurn,
} from "./skill-autoload.ts";
import { nextSuggestion } from "./streaming.ts";
import { elideWithinTurnToolOutputs } from "./tool-output-elision.ts";
import {
  applyExecutionToolGate,
  collectSyntheticWorkflowSlugs,
  resolveExecutionToolGate,
  resolveNamedWorkflowSlug,
} from "./tools/authoring-palette.ts";
import { listTools, type ToolContext } from "./tools/index.ts";
import { type TurnSignals, wrapTools } from "./tools/sdk-wrap.ts";
import { classifyFallbackSynthesis, turnLoopBudgetStopCondition } from "./turn-helpers.ts";
import type { ConversationStatus, DraftDocument, TurnEvent } from "./types.ts";

export interface RunLoopParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  /**
   * Resolved principal — threaded so synthetic `wf_<slug>` tools in the
   * chat palette can apply the same `gateTenantToolCall` / RBAC check
   * MCP uses. Absent on the chat-adapter and MCP-worker resume paths;
   * the synthetic tools are omitted from the palette in that case.
   */
  principal?: ResolvedPrincipal | null;
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
  /**
   * Pre-registered AbortController for this turn. The route / MCP /
   * service-layer caller registers it on the synchronous frame of
   * request-accept (or right after row insert in the create flow)
   * and threads it through. The loop consumes it; lifetime ownership
   * stays with the caller (whoever registered also unregisters in
   * their `finally`). Every caller of `runLoop` threads a controller
   * — there is no fallback registration here, which would re-open
   * the cancel race.
   */
  turn_abort_ctrl: AbortController;
  /**
   * Set when the caller has ALREADY inserted the `conversation_messages`
   * user row for this turn (the MCP async-Tasks path persists the
   * message before enqueueing the `conversation.run-turn` job so the
   * worker can read it back). The loop then skips its own insert to
   * avoid a duplicate row, but still rewrites attachment slugs + emits
   * the `message` event so context assembly and the event replay are
   * unchanged. Defaults to `false` — every synchronous caller persists
   * inside the loop as before.
   */
  user_message_persisted?: boolean;
  /**
   * Per-turn opt-out for the next-message preview frame. When set,
   * the loop still emits a `next_suggestion` event so the SSE close
   * is deterministic, but with `suggestion: null, reason:
   * "client-suppress"` and no model call. sk-cli flips this to true
   * after N consecutive dismissals.
   */
  next_suggestion_suppress?: boolean;
  /**
   * MCP-native elicitation bridge. Present ONLY when this turn runs
   * inside an MCP `tools/call` whose client advertised the
   * `elicitation` capability. Set on the `ToolContext` so input-
   * collecting tools (`ask_user_*`, `authenticate_oauth`) can surface
   * forms + OAuth prompts directly in the client instead of taking the
   * DB-pause / `respondElicitation` round-trip. `undefined` on the
   * HTTP/SSE portal surface.
   */
  elicitationBridge?: ElicitationBridge;
}

export interface RunLoopResult {
  events: TurnEvent[];
  status: "awaiting_input" | "committed" | "active" | "abandoned" | "exhausted";
  committed_workflow_id?: string;
  pending_elicitation_id?: string;
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
  // Caller registers + unregisters on their synchronous-accept frame
  // (A4). The loop only consumes the signal here;
  // re-registering inside this body would re-open the cancel race.
  const turnAbortCtrl = p.turn_abort_ctrl;

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

  // Honest per-turn cost accounting, accumulated step-by-step in
  // onStepFinish (fallback attempts included). Two distinct numbers:
  //   - promptTokensLastCall: the FINAL LLM call's prompt size
  //     (input + cache read + cache creation) — the only figure that is
  //     comparable to `context_cap_tokens`. Pre-fix sk divided the
  //     turn-CUMULATIVE tokens by the per-prompt cap and showed
  //     `ctx 464k/180k (100%)` — apples over oranges.
  //   - turnTokensTotal: sum of every token (prompt + completion +
  //     cache) across all LLM calls of this turn.
  let promptTokensLastCall: number | null = null;
  let turnTokensTotal = 0;

  // Rewrite `@attachment:<slug>` chat-text tokens to the canonical
  // `[file:fid_...]` sentinel before persistence so every downstream
  // surface (model-message replay, LLM file-context assembler, audit)
  // sees a single normalized form. Unresolved slugs stay as the literal
  // `@attachment:<slug>` token so the model can ask a clarifying
  // question on the next turn. Slug → file_id lookup is scoped to this
  // conversation's `file_links` rows by `resolveAttachmentSlugsInText`.
  let ingestedUserMessage: string | null = p.user_message;
  if (p.user_message) {
    // When `user_message_persisted` is set the MCP handler already ran
    // this resolution before persisting the row; re-running it here is
    // deliberately idempotent — `resolveAttachmentSlugsInText` on
    // already-resolved text is a no-op (no `@attachment:` tokens left),
    // so the loop need not branch on whether the caller pre-resolved.
    const rewrite = await resolveAttachmentSlugsInText(p.user_message, {
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
    });
    ingestedUserMessage = rewrite.text;
    // The MCP async-Tasks worker path persists the user row before
    // enqueue (so it survives a crash between accept and turn-start);
    // skip the insert here to avoid a duplicate. All synchronous
    // callers leave `user_message_persisted` falsy and persist here.
    if (!p.user_message_persisted) {
      await appendMessage(p.db, p.tenant_id, p.conversation_id, "user", {
        text: ingestedUserMessage,
      });
    }
    events.push({ type: "message", role: "user", content: { text: ingestedUserMessage } });
  }

  const detectedIntent = detectUserIntent(ingestedUserMessage);
  let workflowIdForTurn = p.workflow_id;

  // Draft state for the turn — tools mutate via ctx.setDraft, which
  // snapshots to conversation_drafts for audit/undo.
  let draft: DraftDocument = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  const hasBoundSavedWorkflow =
    workflowIdForTurn !== null ||
    draft.summary?.active_target.kind === "workflow" ||
    draft.summary?.persisted_resources.some((resource) => resource.kind === "workflow") === true;
  // Guard against the intent heuristic wiping a non-empty unsaved
  // workflow draft. A "rebuild the workflow"-style message while an
  // in-progress draft with authored steps is live must not destroy
  // that work; only an already-persisted target may be reset here.
  // (Predicate lives in authoring-state.ts so the gate and its unit test
  // share one source of truth.)
  if (
    detectedIntent.startNewWorkflow === true &&
    hasBoundSavedWorkflow &&
    !hasInProgressWorkflowDraft(draft)
  ) {
    // An explicit "create a workflow" request starts a fresh draft.
    // Keeping the previous saved workflow target here would turn the
    // next commit into an in-place update of the old workflow.
    draft = startNewWorkflowDraft(draft);
    workflowIdForTurn = null;
    await p.db
      .update(conversations)
      .set({ target_workflow_id: null, updated_at: new Date(now()) })
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
    principal: p.principal ?? null,
    connector_id: p.connector_id,
    workflow_id: workflowIdForTurn,
    permission_mode: p.permission_mode ?? null,
    engineClient: new EngineClient({
      tenant_id: p.tenant_id,
      actor_id: p.actor_id,
      // Single-source the attribution class from the resolved principal:
      // a user session → "user", an API-key (system_account) → "system_account",
      // and an absent principal (resume / chat-adapter paths) → "system".
      actor_type: actorFields(p.principal).actor_type,
      db: p.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
      await appendSnapshot(p.tenant_id, p.conversation_id, next, p.db);
    },
    abortSignal: turnAbortCtrl.signal,
    recentUserMessage: ingestedUserMessage ?? null,
    // MCP-native elicitation bridge — undefined on the HTTP/SSE portal
    // surface. The `perCallCtx = { ...ctx }` spread in sdk-wrap/invoke
    // carries it onto every tool's per-call context automatically.
    ...(p.elicitationBridge ? { elicitationBridge: p.elicitationBridge } : {}),
  };

  const route = await resolveModelRoute(p.tenant_id, p.db);
  // Authoring-intent seeding: if the user's current message expresses
  // workflow-authoring intent ("build a workflow ...", "erstelle einen
  // workflow ...") AND no explicit per-conversation model override is
  // set, seed the FIRST step with the documented authoring-quality
  // default (Sonnet 4.6) instead of the global tenant default (Haiku
  // 4.5 per the 2026-05-22 cost change). The step-router's
  // `model_swapped` ladder continues to apply for later steps; this
  // only changes the seed. Non-authoring conversations (enumeration,
  // run, delete, list) keep the tenant default — `resolveInitialModel`
  // returns the tenant default for them.
  const initialModel = resolveInitialModel({
    modelOverride: p.model_override,
    tenantDefault: route.primary,
    recentUserMessage: ingestedUserMessage,
  });
  const effectiveModel = initialModel.modelId;
  if (initialModel.authoringSeeded) {
    log.debug({
      module: "conversation",
      action: "loop.authoring_intent_seeded_model",
      conversation_id: p.conversation_id,
      tenant_id: p.tenant_id,
      tenant_default_model: route.primary,
      seeded_model: effectiveModel,
    });
  }

  // Step-router signals — refreshed per turn. The router never
  // downgrades the tenant default; it only escalates upward when one
  // of these flips true.
  const stepRouterSignals: StepRouterSignals = {
    hadRepairThisTurn: false,
    strongRunIntent:
      detectedIntent.forceTool === "run_workflow" ||
      detectedIntent.forceTool === "build_workflow" ||
      detectedIntent.forceTool === "save_workflow_draft",
    multiArtifactIntent: detectMultiArtifactIntent(ingestedUserMessage),
    priorCriticFail: false,
  };

  // Pre-check budget. Worst case: `budget` steps × ~1 K output each +
  // the assembled prompt. Matches the envelope `callWithFallback`
  // used before A5.
  const currentUserText = ingestedUserMessage ?? "continue";
  // Single consolidated read of the conversation row: loaded_skills (new
  // {slug,last_turn} recency shape), tool_policies, and the persisted
  // target_connector_id (folds the prior separate SELECTs — the two old
  // loaded_skills reads and the activeConnectorId lookup). The turn
  // counter is NOT read here: it is bumped atomically below via UPDATE …
  // RETURNING so concurrent turns cannot collapse a recency index.
  const convRow = await p.db
    .select({
      loaded_skills: conversations.loaded_skills,
      tool_policies: conversations.tool_policies,
      target_connector_id: conversations.target_connector_id,
    })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  const loadedEntries = parseLoadedSkills(convRow[0]?.loaded_skills, ({ dropped, raw }) =>
    logger.warn({
      module: "conversation",
      action: "skill_recency.malformed_loaded_skills",
      msg: "dropped malformed loaded_skills entries while reading recency state",
      conversation_id: p.conversation_id,
      tenant_id: p.tenant_id,
      dropped,
      raw,
    }),
  );
  // Increment the recency clock exactly once per turn, BEFORE any tool can
  // run, and persist it immediately so mid-turn writers (load_skill, the
  // tool-call autoload) stamp `last_turn` against the same turn index.
  // Atomic increment + RETURNING in one round-trip: a read-modify-write
  // would let two concurrent turns on the same conversation both read N and
  // both write N+1 (webhook + chat dual delivery, double-tapped send),
  // collapsing two turns into one recency index.
  const [turnRow] = await p.db
    .update(conversations)
    .set({ turn_count: sql`${conversations.turn_count} + 1` })
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .returning({ turn_count: conversations.turn_count });
  const currentTurn = turnRow?.turn_count ?? 1;
  const loopToolPolicies = (convRow[0]?.tool_policies ?? {}) as Record<
    string,
    "no_confirm" | "confirm_before_execution" | "confirm_after_execution"
  >;

  // Auto-load skills based on conversation context — attachment MIME
  // types, recent execution failures, and target workflow presence.
  // Deterministic keyword match against `skills.trigger_keywords`.
  // Files are linked via `file_links WHERE resource_type='conversation'`.
  const attachmentMimeRows = await p.db
    .select({ content_type: files.content_type })
    .from(fileLinks)
    .innerJoin(files, eq(files.id, fileLinks.file_id))
    .where(
      and(
        eq(fileLinks.tenant_id, p.tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, p.conversation_id),
      ),
    );
  const attachmentMimeTypes = attachmentMimeRows
    .map((r) => r.content_type)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  let hasFailedExecution = false;
  if (workflowIdForTurn) {
    const failed = await p.db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(eq(executions.tenant_id, p.tenant_id), eq(executions.workflow_id, workflowIdForTurn)),
      )
      .limit(5);
    hasFailedExecution = failed.length > 0; // any prior execution counts as feedback context
  }
  // Lazy-eval gate: skip the intent-skill keyword scan when this turn
  // is a continuation rather than a new topical prompt. Elicitation
  // responses (currentUserText empty) and short affirmations like
  // "yes"/"approve" don't shift the conversation's topic, so the
  // skill set already loaded on the conversation stays valid.
  // Pre-fix the scan ran every turn including approval round-trips,
  // burning tokens on a no-op keyword walk plus its DB lookup of
  // skills by trigger — visible in long sessions where the same
  // conversation paid the scan cost on every "approve" keystroke.
  const trimmedUserText = currentUserText.trim();
  const isContinuationTurn =
    trimmedUserText.length < 8 ||
    /^(yes|no|y|n|ok(ay)?|approve|reject|confirm|cancel|sure|please|thanks?)\b/i.test(
      trimmedUserText,
    );
  const intentSkillSlugs =
    isContinuationTurn && attachmentMimeTypes.length === 0
      ? []
      : await detectIntentSkills(
          p.tenant_id,
          {
            attachmentMimeTypes,
            userMessage: currentUserText,
            hasFailedExecution,
            hasMultipleConnectors: false,
          },
          p.db,
        );

  // Recency-aware full-body skill loading. A loaded skill keeps its full
  // body when it is a baseline skill (core mental model, always refreshed)
  // or still matches this turn's signals via `activates_when`. New
  // autoload additions enter at `last_turn = currentTurn` so they are
  // full-body immediately. On a continuation turn (short "approve"/"yes")
  // the topic has not shifted — refresh baseline only and leave topical
  // `last_turn`s untouched, so a short affirmation neither promotes nor
  // demotes a topical skill. This is NOT the old ratchet: idle topical
  // skills still age out after K turns and fall back to the skill index.
  const loadedSlugs = loadedEntries.map((e) => e.slug);
  const skillCatalog = await loadActivationCatalog(p.tenant_id, p.db);
  const baselineSlugSet = new Set(listBaselineSlugs(skillCatalog));
  let refreshSet: Set<string>;
  let recencyAdditions: string[] = [];
  if (isContinuationTurn && attachmentMimeTypes.length === 0) {
    refreshSet = new Set(loadedSlugs.filter((s) => baselineSlugSet.has(s)));
  } else {
    const scope = await resolveScopeFactsForConversation(
      p.db,
      p.tenant_id,
      p.conversation_id,
      null,
    );
    const reaffirmed = reaffirmLoadedForTurn(
      {
        mode: "user_turn",
        user_text: currentUserText,
        connector_drivers: scope.connector_drivers,
        connector_templates: scope.connector_templates,
      },
      skillCatalog,
      loadedSlugs,
    );
    refreshSet = new Set<string>([
      ...loadedSlugs.filter((s) => baselineSlugSet.has(s)),
      ...reaffirmed,
    ]);
    recencyAdditions = autoloadForUserTurn(
      {
        user_text: currentUserText,
        connector_drivers: scope.connector_drivers,
        connector_templates: scope.connector_templates,
        first_turn: currentTurn === 1,
      },
      skillCatalog,
      loadedSlugs,
    );
  }
  const recency = applyRecency(
    loadedEntries,
    currentTurn,
    refreshSet,
    recencyAdditions,
    baselineSlugSet,
  );
  // Persist the recency-updated array (refreshed last_turns, additions,
  // and prunes of entries past the K-turn window) in one tenant-scoped
  // write. Merge-by-slug semantics are owned by `applyRecency`.
  await p.db
    .update(conversations)
    .set({ loaded_skills: recency.next })
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)));
  // The PROMPT body set is recency-filtered: only full-body slugs reach
  // the assembler as `loaded_skill_slugs`. The PALETTE membership (the
  // `loadedSlugMembership` below) is the full set so skill-gated tools
  // stay unlocked even when a skill has aged out of the full-body window.
  const explicitSkillSlugs = recency.fullBodySet;
  const loadedSlugMembership = recency.membership;
  const loadedSkillSlugs = [...new Set([...explicitSkillSlugs, ...intentSkillSlugs])];

  // Surface document-analysis registry summary for the active connector
  // so the model sees what was extracted without needing to re-read it.
  let documentAnalysisSummary: {
    source: string;
    confidence: number;
    endpoint_count: number;
    sample_endpoints: Array<{ method: string; path: string }>;
  } | null = null;
  // Folded into the consolidated `convRow` read above — no separate
  // SELECT for the persisted target_connector_id.
  const activeConnectorId = p.connector_id ?? convRow[0]?.target_connector_id ?? null;
  if (activeConnectorId) {
    const epRows = await p.db
      .select({
        method: connectorEndpointSchemas.method,
        path: connectorEndpointSchemas.path,
        source: connectorEndpointSchemas.source,
        confidence: connectorEndpointSchemas.confidence,
      })
      .from(connectorEndpointSchemas)
      .where(
        and(
          eq(connectorEndpointSchemas.tenant_id, p.tenant_id),
          eq(connectorEndpointSchemas.connector_id, activeConnectorId),
        ),
      )
      .limit(50);
    const head = epRows[0];
    if (head) {
      documentAnalysisSummary = {
        source: head.source,
        confidence: head.confidence,
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
  // Connectors bound to this conversation's draft — the assembler's
  // "Recorded endpoint samples" section loads the latest recorded
  // response shapes for exactly these ids (payload-first authoring
  // context). Collected from the active/target connector, the persisted
  // draft connector, and every connector a draft workflow step
  // references; non-UUID placeholders are filtered at the loader.
  const authoringConnectorIds = [
    ...new Set(
      [
        activeConnectorId,
        typeof draft.connector?.saved_connector_id === "string"
          ? draft.connector.saved_connector_id
          : null,
        ...draft.workflow.steps.map((step) => {
          const cid = step.connector_id;
          return typeof cid === "string" ? cid : null;
        }),
      ].filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  // Run-verb bias: a message like "run acme-jira-test-plans" or
  // "starte foo" tilts the prompt's authoring_hint.mode to `execution`
  // even when no draft summary exists yet, so EXECUTION_PERSONA fires
  // for that turn and the tenant snapshot's HARD RULE about
  // `wf_<slug>` wins over the default authoring-leaning persona. The
  // fast-path matcher in `fast-path.ts` usually intercepts these
  // intents before the LLM runs at all; this bias is for the genuinely-
  // ambiguous LLM-routed cases ("run X if Y else Z").
  const runVerbBiasFires = (() => {
    if (!currentUserText) return false;
    // Shared with `fast-path.ts` so the two surfaces never drift.
    return RUN_VERB_RE.test(currentUserText);
  })();
  const authoringHint = draft.summary
    ? {
        mode:
          runVerbBiasFires && draft.summary.mode === "workflow"
            ? ("execution" as const)
            : draft.summary.mode,
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
    .where(
      and(
        eq(conversationToolCalls.tenant_id, p.tenant_id),
        eq(conversationToolCalls.conversation_id, p.conversation_id),
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(8);
  // Expand recent failing tool-call rows into per-turn prior_failures
  // entries. Critic rejections fan out into one row per repair tagged
  // `step_id:"critic"`; every other rejection becomes one row keyed by
  // the producing tool name. Pure function — see
  // `authoring-critic/prior-failures.ts` for the contract and unit tests.
  const expanded = expandPriorFailuresFromToolCalls(recentToolCalls);
  if (expanded.hadCriticReject) {
    stepRouterSignals.priorCriticFail = true;
  }
  const combinedPriorFailures = [...priorFailuresFromPreview, ...expanded.entries];

  const prompt = await timePhaseAsync("converse.assemble_prompt", async () =>
    assembleEnhancedPrompt(
      {
        tenant_id: p.tenant_id,
        flow: "converse",
        ...(p.connector_id ? { connector_id: p.connector_id } : {}),
        ...(workflowIdForTurn ? { workflow_id: workflowIdForTurn } : {}),
        user_turns: await (async () => {
          const parts = await buildUserContentParts(
            p.db,
            p.tenant_id,
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
        // Index-safety: every loaded slug (recency-filtered or not) must
        // stay referenceable. The assembler renders any membership slug
        // not already full-body as a one-line "Loaded" index entry so a
        // demoted connector/workflow-scoped-out-of-scope or experimental
        // skill never disappears — one `load_skill` re-promotes it.
        ...(loadedSlugMembership.length > 0
          ? { loaded_skill_membership: loadedSlugMembership }
          : {}),
        ...(p.surface ? { surface: p.surface } : {}),
        ...(authoringContext ? { authoring_context: authoringContext } : {}),
        ...(authoringHint ? { authoring_hint: authoringHint } : {}),
        ...(authoringConnectorIds.length > 0
          ? { authoring_connector_ids: authoringConnectorIds }
          : {}),
        ...(combinedPriorFailures.length > 0 ? { prior_failures: combinedPriorFailures } : {}),
        conversation_id: p.conversation_id,
        ...(p.runtime_context
          ? {
              runtime_context: {
                ...(p.runtime_context.engine_url
                  ? { engine_url: p.runtime_context.engine_url }
                  : {}),
                ...(p.runtime_context.tenant_slug
                  ? { tenant_slug: p.runtime_context.tenant_slug }
                  : {}),
                ...(p.runtime_context.actor_email
                  ? { actor_email: p.runtime_context.actor_email }
                  : {}),
                ...(p.runtime_context.actor_role
                  ? { actor_role: p.runtime_context.actor_role }
                  : {}),
                ...(p.surface ? { surface: p.surface } : {}),
                ...(p.permission_mode ? { permission_mode: p.permission_mode } : {}),
              },
            }
          : p.permission_mode
            ? { runtime_context: { permission_mode: p.permission_mode } }
            : {}),
      },
      p.db,
    ),
  );
  const messages = await timePhaseAsync("converse.build_model_messages", () =>
    buildModelMessages(p.db, p.tenant_id, p.conversation_id, {
      conversationEnvelope: true,
      conversation_id: p.conversation_id,
    }),
  );
  const messageTokens = timePhase("converse.count_message_tokens", () =>
    countModelMessagesTokens(messages),
  );
  const estimatedPromptTokens = prompt.token_counts.total + messageTokens;
  const estimated = estimatedPromptTokens + budget * 1024;

  // Pre-flight context-window check. The provider rejects oversize
  // prompts with a 400 ("prompt is too long: N tokens > 200000 maximum")
  // — by then the user has paid the latency and we've burned a quota
  // decrement on a doomed call. Catch it here, raise a typed error
  // the CLI can map to actionable guidance ("conversation too long;
  // try /compact"). The cap is the assembler's usable window, which
  // already accounts for completion headroom (see `contextCapFor`).
  const contextCap = contextCapFor(effectiveModel);
  if (estimatedPromptTokens > contextCap) {
    logger.warn({
      module: "conversation",
      action: "preflight.context_too_large",
      msg: "rejecting turn before provider call — assembled prompt exceeds context cap",
      conversation_id: p.conversation_id,
      tenant_id: p.tenant_id,
      model: effectiveModel,
      estimated_prompt_tokens: estimatedPromptTokens,
      context_cap: contextCap,
      message_tokens: messageTokens,
      prompt_breakdown: prompt.token_counts,
    });
    throw new LlmContextTooLarge("llm_context_too_large", {
      estimated_prompt_tokens: estimatedPromptTokens,
      context_cap: contextCap,
      message_tokens: messageTokens,
      prompt_total: prompt.token_counts.total,
      model: effectiveModel,
      remediation: "compact_or_resume",
    });
  }

  const actor = actorFields(p.principal);
  try {
    await checkBudget(p.tenant_id, estimated, route.monthly_budget, p.db);
    const verdict = await checkAndDecrement(p.tenant_id, estimated, p.db, actor.user_id);
    if (!verdict.ok) {
      throw new LlmQuotaExhausted("llm_quota_exhausted", {
        used: verdict.used,
        projected_tokens: verdict.projected_tokens,
        budget: verdict.budget,
        remaining: verdict.remaining,
        scope: verdict.scope ?? "tenant",
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
          ...actor,
        },
        p.db,
      );
      recordLlmQuotaExhausted({ tenant_id: p.tenant_id });
    }
    throw err;
  }

  // PALETTE membership: skill-gated tools must see the FULL set of loaded
  // slugs (`loadedSlugMembership` from the consolidated read above), NOT
  // the recency-filtered full-body subset — a skill that aged out of the
  // full-body window still keeps its gated tools unlocked. Only the PROMPT
  // BODY rendering is recency-filtered; the palette is not.
  //
  // Auto-load the canonical authoring skills so the palette exposes both
  // the connector and workflow tool sets from turn one. The user's first
  // message could go either way ("create a connector for foo" / "build a
  // workflow that bars"); exposing both sets up front avoids the dead-end
  // where the LLM has to call `load_skill` twice before it can do anything
  // (and avoids the 00b93a52 failure where the model said "tool not in
  // palette" and asked the user to restart). The skill BODIES are still
  // pulled into the prompt only when needed (recency window above) — this
  // auto-load only shapes the PALETTE, not the prompt budget.
  const AUTO_LOADED_AUTHORING_SKILLS: ReadonlyArray<string> = [
    "connector-creation-guidance",
    "workflow-authoring",
  ];
  const loadedSkills = [...new Set([...loadedSlugMembership, ...AUTO_LOADED_AUTHORING_SKILLS])];
  logger.debug({
    module: "conversation_palette",
    action: "palette.resolved",
    msg: "resolved authoring palette",
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    loaded_skills: loadedSkills,
    persisted_skills_count: loadedSlugMembership.length,
  });

  const signals: TurnSignals = {
    step: 0,
    toolChain: Promise.resolve(),
    assistantMessageId: null,
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
  };
  const wrappedTools = await wrapTools(
    ctx,
    signals,
    events,
    p.db,
    loadedSkills,
    loopToolPolicies,
    p.permission_mode ?? null,
    p.principal ?? null,
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

  // Pre-dispatch policy resolution (resolveExecutionMode +
  // recordToolPolicyConfirmationRequired audit) lives inline at the top
  // of `wrapOne`'s execute — no second wrapping layer here. See
  // `tools/sdk-wrap/invoke.ts` for the fold rationale: the previous
  // two-layer wrap held ~218 closures simultaneously per turn (one per
  // tool × two wraps) and forced a duplicate `tools` map.
  const tools = wrappedTools;

  // Default-deny execution-tool gate. `run_workflow` and every synthetic
  // `wf_<slug>` peer EXECUTE an existing saved workflow; leaving them in an
  // authoring conversation with no run target lets the model "satisfy" a build
  // request by running the closest lookalike and stalling on its input form —
  // the notion-essay-to-markdown / page_id hijack. Exposure is keyed on DURABLE
  // state only — a saved workflow bound to this turn, or a slug the user named —
  // never on free-text run/authoring phrasing, so a negated build request
  // ("...do NOT run...") or a weak continuation ("retry from scratch") can never
  // re-expose a lookalike execution tool. See `authoring-palette.ts` for the
  // gate rationale. The binding check runs AFTER the build-new detach above, so
  // a "create a new workflow" turn that detached its old target is correctly
  // treated as having no run target.
  const syntheticWorkflowSlugs = collectSyntheticWorkflowSlugs(Object.keys(tools));
  const hasBoundSavedWorkflowTarget =
    workflowIdForTurn !== null ||
    (draft.summary?.active_target.kind === "workflow" &&
      draft.summary?.active_target.lifecycle_state === "persisted");
  const executionGate = resolveExecutionToolGate({
    hasBoundSavedWorkflow: hasBoundSavedWorkflowTarget,
    explicitlyNamedWorkflowSlug: resolveNamedWorkflowSlug(
      ingestedUserMessage,
      syntheticWorkflowSlugs,
    ),
  });
  const removedExecutionTools = applyExecutionToolGate(
    tools,
    executionGate,
    syntheticWorkflowSlugs,
  );
  if (removedExecutionTools > 0) {
    logger.debug({
      module: "conversation",
      action: "loop.intent.suppress_run_workflow",
      msg: "no bound or named saved workflow — execution tools removed from this turn's palette",
      conversation_id: p.conversation_id,
      reason: executionGate.reason,
      removed_count: removedExecutionTools,
    });
  }

  // Steer toolChoice from explicit user intent. Without this, the model
  // sees "auto" and can decide to just narrate ("the workflow already
  // filters correctly") without actually calling the tool — exactly the
  // hallucination reported in session f44bf9b4. We only force a tool when
  // (a) the detector sees a strong run-intent verb in any supported
  // language and (b) that tool actually exists in the palette this turn.
  const stateDrivenTool = inferStateDrivenFollowUpTool({
    latestUserText: ingestedUserMessage,
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
    let lastStepEnd = now();
    // Per-turn repair counter for experimental_repairToolCall. See
    // MAX_REPAIRS_PER_TURN constant.
    let turnRepairCount = 0;
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
    const resolvedModel = await resolveLanguageModel(route.provider, modelId, p.tenant_id);
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
    const cacheBlocks = timePhase("converse.split_cache_blocks", () =>
      splitPromptIntoBlocks(prompt, "converse"),
    );
    // The converse flow always opts into caching when the provider
    // supports it — the per-tenant `enable_prompt_cache` setting still
    // gates the one-shot flows (generate / repair / extract) via
    // invoke.ts, but an interactive authoring loop benefits too much
    // from cache hits to stay off by default.
    const systemMessages = toSystemMessages(cacheBlocks, {
      enabled: cacheSupported,
      ttl: "1h",
    });
    // Activity ticker: flip the CLI status line to "composing" before
    // we hand off to the provider. Without this the user sees only
    // the spinner for the LLM-generation phase (often 30–90s) with no
    // hint that the engine is waiting on the model rather than stuck
    // in a tool call. Model identifier intentionally NOT included —
    // operators don't need provider/model details on the live ticker.
    events.push({
      type: "activity",
      phase: "composing",
      label: "composing reply",
    });
    // Build a name → ConversationTool map once for the step-router's
    // activeTools narrowing decisions. Using the registry (not the
    // wrappedTools map) so router logic reads `category` directly.
    const toolsByName: Record<string, import("./tools/index.ts").ConversationTool> = {};
    for (const t of listTools()) toolsByName[t.name] = t;

    // Parallel tool calls stay DISABLED at the provider layer for the
    // entire turn. We previously tried to flip this ON for stages that
    // looked read-only, but the decision is fixed at streamText
    // construction (AI SDK 6.x prepareStep cannot override
    // providerOptions) and a turn that starts in `idle` can transition
    // into `propose_step` / `save_workflow_draft` mid-turn — at which point
    // tenant_write tools could race. Keeping the disable on is the
    // only correct setting until the SDK exposes per-step
    // providerOptions overrides. The in-process serialisation mutex on
    // `signals.toolChain` (sdk-wrap.ts) protects draft mutations
    // regardless of provider batching, but the provider-side
    // disable removes the head-of-line racing entirely.
    const turnStageReadOnly = false;
    // Extended thinking — turn-level providerOptions. AI SDK 6.x
    // applies providerOptions for the entire streamText invocation;
    // there is no per-step override. We grant the budget when the
    // turn starts on a hard stage and the model supports it; the
    // model uses (or ignores) it per step at the provider's
    // discretion.
    const turnEnableThinking = (() => {
      const stage = draft.summary?.stage;
      if (
        stage !== "connector_validated" &&
        stage !== "connector_persisted" &&
        stage !== "workflow_validated" &&
        stage !== "workflow_persisted" &&
        stage !== "repairing"
      ) {
        return false;
      }
      return supportsExtendedThinking(route.provider, modelId);
    })();
    // Anthropic API rejects thinking + forced tool_choice (observed as
    // `converse.failed` ×3 in session 0498925e). The decision lives in
    // `llm/core/thinking-policy.ts` so step-router can read the same
    // policy when it considers escalating to `toolChoice: "required"`.
    // `preferredTool` is `string | null` — compare against null, not
    // undefined (a `!== undefined` check is always true here and would
    // suppress thinking on EVERY turn, including the hard stages above).
    const turnForcesTool = preferredTool != null;
    const thinkingDecision = resolveThinking({
      enableThinking: turnEnableThinking,
      forcesTool: turnForcesTool,
    });
    const thinkingThisTurn = thinkingDecision.enabled;
    logger.debug({
      module: "llm",
      action: "turn.provider_options",
      msg: "resolved per-turn provider gates",
      conversation_id: p.conversation_id,
      tenant_id: p.tenant_id,
      provider: route.provider,
      model: modelId,
      stage: draft.summary?.stage ?? "idle",
      parallel_tools_enabled: turnStageReadOnly,
      extended_thinking_enabled: thinkingThisTurn,
      thinking_suppressed_by_forced_tool: thinkingDecision.suppressedByForcedTool,
      cache_supported: cacheSupported,
    });
    // Anthropic-native server-side web search. Only valid for Anthropic
    // Claude models, and only when the tenant has the `llm.web_search`
    // config leaf enabled (default on). Billed per search by Anthropic.
    // The mock path (route.provider !== "anthropic") never adds it, so
    // determinism in the integration suite is preserved.
    const webSearchSetting = (() => {
      try {
        return getConfig(p.tenant_id).llm.web_search === true;
      } catch {
        // Loader not initialised (unit tests) → omit the tool gracefully.
        return false;
      }
    })();
    const webSearchEnabled = anthropicWebSearchApplies(route.provider, modelId, webSearchSetting);
    const turnTools: ToolSet = webSearchEnabled
      ? { ...tools, web_search: buildAnthropicWebSearchTool(5) }
      : tools;
    const result = streamText({
      model: resolvedModel,
      system: systemMessages,
      messages: attemptMessages,
      tools: turnTools,
      toolChoice: preferredTool
        ? { type: "tool" as const, toolName: preferredTool }
        : forceNoTools
          ? "none"
          : "auto",
      // Disable parallel tool calls on Anthropic for state-changing
      // turns (the rationale at session "starte mit übermorgen" still
      // holds). Read-heavy turns flip parallel ON so multiple
      // tenant_read tools can run concurrently — they have no
      // serialisation requirement.
      ...(cacheSupported
        ? {
            providerOptions: {
              anthropic: {
                disableParallelToolUse: !turnStageReadOnly,
                ...(thinkingThisTurn
                  ? // claude-sonnet-4-5+/opus-4-6+ rejected the legacy
                    // `{ type: "enabled", budgetTokens }` shape
                    // ("thinking.type.enabled is not supported for this
                    // model") — caught by nightly.yml's real-LLM job.
                    // `adaptive` lets the model size its own thinking
                    // budget per turn, which is what we want anyway
                    // (the 4000-token cap was a guess).
                    { thinking: { type: "adaptive" as const } }
                  : {}),
              },
            },
          }
        : {}),
      // experimental_repairToolCall — when the model emits a tool call
      // whose JSON args fail validation (or names a non-existent tool),
      // the SDK calls this hook to ask for a repaired call. Sets a
      // step-router signal so the next step escalates one tier up.
      // Capped at MAX_REPAIRS_PER_TURN (2) per the plan: a model that
      // keeps emitting malformed calls is in a degenerate state and
      // burning more LLM budget on repair won't help — surface the
      // failure so the next turn escalates.
      experimental_repairToolCall: ({
        toolCall,
        tools: callTools,
        error,
        messages: callMessages,
        system: callSystem,
      }) => {
        if (turnRepairCount >= MAX_REPAIRS_PER_TURN) {
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
        turnRepairCount += 1;
        return repairToolCallHandler({
          toolCall,
          // biome-ignore lint/suspicious/noExplicitAny: ToolSet vs our wrapped map.
          tools: callTools as any,
          messages: callMessages,
          system: callSystem,
          error,
          model: resolvedModel,
          onRepair: () => {
            stepRouterSignals.hadRepairThisTurn = true;
            // G7: capture which tool's repair drove the upgrade so the
            // model_swapped log line below can attribute it. Pre-fix
            // the log said `reason: repair_in_prior_step` but did not
            // name the failing tool — operators had to bisect adjacent
            // log lines for the matching `repair_tool_call.started`
            // entry to find out.
            const errKind =
              error && typeof error === "object" && "name" in (error as object)
                ? String((error as { name?: unknown }).name)
                : undefined;
            stepRouterSignals.repairAttribution = {
              tool: toolCall.toolName,
              ...(errKind ? { error_kind: errKind } : {}),
            };
          },
        });
      },
      // prepareStep — per-step routing decisions: model escalation,
      // activeTools narrowing, extended-thinking enablement. Returns
      // undefined to mean "no override" so the loop's existing config
      // wins on routine steps.
      prepareStep: async ({ stepNumber, steps, messages: stepMessages, model: stepModel }) =>
        timePhaseAsync("converse.prepare_step", async () => {
          // Step-boundary memory bracket. With every loop phase exonerated
          // by phase.slow/phase.alloc, these absolute samples localize the
          // ~700MB/turn external churn to within-step (provider call + tool
          // execution) vs between-step work — read the journal pairs.
          {
            const m = process.memoryUsage();
            logger.info({
              module: "process",
              action: "step.memory",
              at: "prepare",
              step_number: stepNumber,
              external_mb: Math.round(m.external / (1024 * 1024)),
              rss_mb: Math.round(m.rss / (1024 * 1024)),
            });
          }
          // Within-turn output elision — bound the live turn's prompt
          // growth at the source. Everything before `attemptMessages.length`
          // is replayed history that persist.buildModelMessages already
          // bounded; tool results produced by THIS turn's agentic loop
          // are stubbed once they are bulky (>4KB serialized) and more
          // than WITHIN_TURN_VERBATIM_ITERATIONS iterations old. The
          // stub carries a `_raw_ref` the model can recover via
          // `get_raw_result` — same contract as the cross-turn path.
          // Pre-fix a 40+-iteration turn re-sent the full tool-output
          // history on every LLM call (session 784c1b02, 3.9M tokens).
          const elision = elideWithinTurnToolOutputs(stepMessages, {
            baseline_index: attemptMessages.length,
          });
          if (elision) {
            logger.info({
              module: "conversation",
              action: "loop.within_turn_elision",
              msg: "stubbed bulky tool outputs from older agentic iterations",
              conversation_id: p.conversation_id,
              tenant_id: p.tenant_id,
              step_number: stepNumber,
              elided_count: elision.elided_count,
              elided_chars: elision.elided_chars,
            });
          }
          const routedMessages = elision ? elision.messages : stepMessages;
          const liveStage = draft.summary?.stage;
          if (liveStage !== undefined) stepRouterSignals.stage = liveStage;
          // Live persisted-workflow gate — recomputed every step so a
          // mid-turn `save_workflow_draft` flips the palette over to
          // include `requires_persisted_workflow` tools immediately on
          // the next step. Mirrors the `hasBoundSavedWorkflow` check at
          // turn-start (target_workflow_id || active_target persisted ||
          // persisted_resources includes a workflow).
          stepRouterSignals.hasPersistedWorkflow =
            workflowIdForTurn !== null ||
            (draft.summary?.active_target.kind === "workflow" &&
              draft.summary?.active_target.lifecycle_state === "persisted") ||
            draft.summary?.persisted_resources.some((resource) => resource.kind === "workflow") ===
              true;
          const decision = routerPrepareStep({
            stepNumber,
            steps,
            messages: routedMessages,
            model: stepModel,
            tenantDefaultModelId: modelId,
            provider: route.provider,
            toolsByName,
            signals: stepRouterSignals,
            turnThinkingEnabled: thinkingThisTurn,
            // Thread the turn-level forced tool so `activeTools` narrowing
            // can never drop it — the AI SDK validates the forced tool
            // against every step's `activeTools` set.
            forcedTool: preferredTool,
          });
          if (!decision) return elision ? { messages: elision.messages } : {};
          const result: Record<string, unknown> = elision ? { messages: elision.messages } : {};
          if (decision.modelId && decision.modelId !== modelId) {
            try {
              result.model = await resolveLanguageModel(
                route.provider,
                decision.modelId,
                p.tenant_id,
              );
              logger.info({
                module: "llm",
                action: "step_router.model_swapped",
                msg: "per-step model upgraded",
                conversation_id: p.conversation_id,
                tenant_id: p.tenant_id,
                step_number: stepNumber,
                from_model: modelId,
                to_model: decision.modelId,
                stage: stepRouterSignals.stage ?? "idle",
                had_repair: stepRouterSignals.hadRepairThisTurn === true,
                prior_critic_fail: stepRouterSignals.priorCriticFail === true,
                strong_run_intent: stepRouterSignals.strongRunIntent === true,
                reason: decision.reason ?? null,
                ...(stepRouterSignals.repairAttribution
                  ? {
                      repair_tool: stepRouterSignals.repairAttribution.tool,
                      ...(stepRouterSignals.repairAttribution.error_kind
                        ? { repair_error_kind: stepRouterSignals.repairAttribution.error_kind }
                        : {}),
                    }
                  : {}),
              });
            } catch (err) {
              logger.warn({
                module: "llm",
                action: "step_router.resolve_failed",
                msg: "could not resolve upgraded model — sticking with tenant default",
                conversation_id: p.conversation_id,
                tenant_id: p.tenant_id,
                provider: route.provider,
                target: decision.modelId,
                fallback_model: modelId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (decision.activeTools !== undefined) {
            result.activeTools = decision.activeTools;
            logger.debug({
              module: "llm",
              action: "step_router.tools_narrowed",
              msg: "per-step tool palette restricted by stage",
              conversation_id: p.conversation_id,
              step_number: stepNumber,
              stage: stepRouterSignals.stage ?? "idle",
              active_tool_count: decision.activeTools.length,
              full_tool_count: Object.keys(toolsByName).length,
            });
          }
          if (decision.reason) {
            logger.debug({
              module: "llm",
              action: "step_router.decision",
              msg: "step router emitted a non-default decision",
              conversation_id: p.conversation_id,
              step_number: stepNumber,
              target_model: decision.modelId ?? modelId,
              reason: decision.reason,
            });
          }
          return result;
        }),
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
        // No-progress repair stop: N consecutive dry_run_workflow results
        // with the SAME requires_repair / judge-missing fingerprint mean
        // the build→dry_run→edit loop is stalled — stop the turn and let
        // the assistant surface the verdict instead of re-driving it to
        // the step budget. Belt to P3's suspenders (P3 makes the judge
        // advisory-commit at its cap; this halts a model that keeps
        // re-driving before that).
        // biome-ignore lint/suspicious/noExplicitAny: SDK StopCondition generic over variadic ToolSet; runtime contract matches.
        noProgressRepairStopCondition as any,
      ],
      // Retry transient provider errors (Anthropic `Overloaded`/529, 429,
      // 5xx) with the SDK's exponential backoff BEFORE the catch below
      // engages the fallback model. Pre-fix this was 0 — a single
      // `Overloaded` blip dropped every converse turn straight onto the
      // weaker fallback, which then authored worse JSONata.
      maxRetries: 2,
      abortSignal: streamAbortSignal,
      experimental_telemetry: {
        isEnabled: true,
        // Record full prompt/output span attributes ONLY when an exporter
        // is configured: the SDK stringifies them eagerly per step even
        // into noop spans — megabytes of serialization garbage per turn
        // on a no-exporter deployment, for attributes nobody sees.
        recordInputs: isTracingActive(),
        recordOutputs: isTracingActive(),
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
      onStepFinish: async (step) =>
        timePhaseAsync("converse.on_step_finish", async () => {
          {
            const m = process.memoryUsage();
            const external_mb = Math.round(m.external / (1024 * 1024));
            // When the step ended with >768MB external, name WHO holds it:
            // bun:jsc heapStats counts live objects by type — the brackets
            // located a ~1.5GB allocation inside the first step of a turn;
            // the type counts turn "something big" into a class name.
            let heap_top: Array<[string, number]> | undefined;
            let heap_size_mb: number | undefined;
            if (external_mb > 768) {
              try {
                const { heapStats } = await import("bun:jsc");
                const h = heapStats();
                heap_size_mb = Math.round(h.heapSize / (1024 * 1024));
                heap_top = Object.entries(h.objectTypeCounts)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 8) as Array<[string, number]>;
              } catch {
                // bun:jsc unavailable (plain node tooling) — skip attribution.
              }
            }
            logger.info({
              module: "process",
              action: "step.memory",
              at: "finish",
              external_mb,
              rss_mb: Math.round(m.rss / (1024 * 1024)),
              ...(heap_size_mb !== undefined ? { heap_size_mb } : {}),
              ...(heap_top ? { heap_top } : {}),
            });
          }
          const u = readStepUsage(step);
          // Per-turn cost telemetry for the `completed` envelope:
          // last-call prompt size (vs. the context cap) + running total.
          promptTokensLastCall = stepPromptTokens(u);
          turnTokensTotal += stepTotalTokens(u);
          const stepEndedAt = now();
          const latency_ms = Math.max(0, stepEndedAt - lastStepEnd);
          lastStepEnd = stepEndedAt;
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
              ...actorFields(p.principal),
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
            // The guard's secret pre-pass uses the code-context-suppressed
            // `findSecretSpans` — see the authoritative redaction contract
            // above `redactGenericTokens` in
            // `packages/shared/src/redaction.ts`.
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
            const assistantContent =
              hasText || guarded.violations.length > 0
                ? {
                    ...(hasText ? { text: guarded.text } : {}),
                    ...(guarded.violations.length > 0
                      ? {
                          _violations: guarded.violations.map((v) => ({
                            kind: v.kind,
                            message: v.message,
                          })),
                        }
                      : {}),
                  }
                : {};
            const assistantMessageId =
              signals.assistantMessageId ??
              (await appendMessage(
                p.db,
                p.tenant_id,
                p.conversation_id,
                "assistant",
                assistantContent,
              ));
            if (signals.assistantMessageId) {
              await updateMessageContent(p.db, assistantMessageId, assistantContent);
            }
            // Back-fill parent_message_id on every child row created during
            // this step so the read path can interleave them under this
            // assistant message in chronological order.
            await setToolCallParentMessage(
              p.db,
              signals.pendingChildToolCallIds,
              assistantMessageId,
            );
            await setElicitationParentMessage(
              p.db,
              signals.pendingChildElicitationIds,
              assistantMessageId,
            );
            signals.pendingChildToolCallIds = [];
            signals.pendingChildElicitationIds = [];
            signals.assistantMessageId = null;
            if (hasText) {
              signals.lastAssistantText = guarded.text;
            }
            events.push({
              type: "message",
              role: "assistant",
              content: assistantContent,
              id: assistantMessageId,
              parent_message_id: assistantMessageId,
            });
          }
        }),
    });
    try {
      // Composing-phase heartbeat. The activity ticker would otherwise
      // sit on the SAME label (`composing reply`) for the entire
      // LLM-generation phase — operator can't tell if the engine is
      // making progress or stuck. Refresh every 5s with just an
      // elapsed-time suffix; the EventSink's `(phase, label)` throttle
      // does NOT collapse these because the label string differs each
      // tick. Cleared by the for-await drain below when text starts
      // arriving (Layer B then carries visibility). Model identifier
      // intentionally NOT included — operator doesn't need it.
      const composingStart = now();
      let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
        const elapsedSec = Math.round((now() - composingStart) / 1000);
        events.push({
          type: "activity",
          phase: "composing",
          label: `composing reply · ${elapsedSec}s`,
        });
      }, 5_000);
      const stopHeartbeat = () => {
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };
      // Drain the text stream so we can emit `text_delta` events as
      // assistant tokens arrive. The onStepFinish callback still runs
      // after the stream completes and appends the full assistant
      // message — text_delta is for live rendering, `message` is the
      // persisted record.
      //
      // Layer-B finalization signal: while prose is actively streaming
      // refresh the activity ticker with a "X paragraphs so far"
      // label every paragraph boundary. Keeps the ticker informative
      // when text IS arriving (the operator sees the bottom-pane line
      // tick alongside the streaming buffer above it). Paragraph
      // boundaries are blank-line separated runs, the same shape the
      // assistant naturally emits between tool-call narrations.
      //
      // text_delta secret scrub: the raw provider chunks are routed
      // through a holdback scrubber so a secret-shaped token never
      // reaches the event sink, even split across chunk seams. The
      // batch guard in onStepFinish covers the PERSISTED message;
      // this covers the live render path. Declared outside the try so
      // the finally below can flush the held tail.
      const deltaScrubber = createStreamScrubber();
      try {
        // Fixed-size tail-only paragraph detection. Pre-fix this used
        // an unbounded `proseBuffer += chunk` plus
        // `proseBuffer.split(/\n\s*\n/)` on EVERY chunk — O(N²) string
        // and array allocations during long replies, plus a per-chunk
        // full-buffer copy. For a 50-KB reply across ~500 chunks that
        // was ~12 MB of transient string garbage just to find paragraph
        // boundaries. The authoritative full-text guard still runs in
        // `onStepFinish` over the complete `step.text`; this loop is
        // purely an early-warning signal.
        const PROSE_TAIL_WINDOW = 4096;
        const PARA_RE = /\n\s*\n/g;
        let proseTail = "";
        let paragraphsEmitted = 0;
        // Cursor into `proseTail` where the next paragraph-boundary
        // scan should start. Reset when the tail-window slice trims
        // the leading bytes off `proseTail` to keep the cursor relative
        // to current tail contents.
        let proseScanFrom = 0;
        for await (const chunk of result.textStream) {
          if (chunk.length === 0) continue;
          // Once tokens arrive, the heartbeat is redundant — Layer B
          // takes over visibility. Stop the timer so we never publish
          // a stale "still composing" tick on top of live tokens.
          stopHeartbeat();
          const safeDelta = deltaScrubber.push(chunk);
          if (safeDelta) events.push({ type: "text_delta", text: safeDelta });
          const prevLen = proseTail.length;
          proseTail = (proseTail + chunk).slice(-PROSE_TAIL_WINDOW);
          // When the slice drops the head, rebase the scan cursor by
          // the same amount so it stays anchored to the last detected
          // boundary inside the current window.
          const trimmed = prevLen + chunk.length - proseTail.length;
          if (trimmed > 0) {
            proseScanFrom = Math.max(0, proseScanFrom - trimmed);
          }
          PARA_RE.lastIndex = proseScanFrom;
          const match = PARA_RE.exec(proseTail);
          if (match) {
            paragraphsEmitted += 1;
            proseScanFrom = match.index + match[0].length;
            if (paragraphsEmitted >= 2) {
              events.push({
                type: "activity",
                phase: "composing",
                label: `composing reply · ${paragraphsEmitted} paragraphs so far`,
              });
            }
            // Overlapped scan: log violations on the latest completed
            // paragraph as soon as it boundaries. Lower bound matches
            // the prior behavior — single-paragraph steps still get a
            // streamed scan.
            const latestParagraph = proseTail.slice(0, match.index);
            if (latestParagraph) {
              runOutputGuardStream(latestParagraph, {
                ...(p.runtime_context?.engine_url
                  ? { engine_url: p.runtime_context.engine_url }
                  : {}),
                ...(p.runtime_context?.tenant_slug
                  ? { tenant_slug: p.runtime_context.tenant_slug }
                  : {}),
              });
            }
          }
        }
      } catch {
        // Drain errors surface via onError/capturedError below; ignore here.
      } finally {
        const tailDelta = deltaScrubber.flush();
        if (tailDelta) events.push({ type: "text_delta", text: tailDelta });
        stopHeartbeat();
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
  let cancelled = false;
  try {
    await runOnce(effectiveModel);
  } catch (primaryErr) {
    // Cancel-vs-error split — see `abort.ts` header for reason coverage.
    if (isExpectedCancellation(primaryErr, turnAbortCtrl.signal)) {
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
          ...actorFields(p.principal),
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
        if (isExpectedCancellation(fbErr, turnAbortCtrl.signal)) {
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
              ...actorFields(p.principal),
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
    const classified = classifyFallbackSynthesis({
      events,
      loopWarnings: signals.totalLoopWarnings,
    });
    if (classified) {
      const synthetic = classified.text;
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
      // Distinguish three turn shapes for ops triage:
      //   - `next_prompt_from_tool` — benign, the freshest tool returned
      //     an actionable next-step the model would have echoed anyway.
      //     Emitted at info level — expected behaviour.
      //   - `tool_results_summary` — the model went silent after one
      //     or more tools fired but no next_prompt was set. Worth
      //     looking at — the tool surface should grow a hint.
      //   - `loop_warnings_no_signal` — loop guard fired AND there
      //     were no tool results to summarise. Emergency apology
      //     line. Always worth investigating.
      const level = classified.reason === "next_prompt_from_tool" ? "info" : "warn";
      log[level]({
        module: "conversation",
        action: "loop.empty_text_synthesized",
        msg: "turn ended with no assistant text — synthesised fallback",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        loop_warnings: signals.totalLoopWarnings,
        synthesis_reason: classified.reason,
      });
    }
  }

  // Root D defence-in-depth: detect hallucinated tool-absence
  // claims. When the LLM's assistant text denies the availability of
  // a tool that IS in the resolved palette this turn (a regression
  // observed in conversation fe9c4ec7 on 2026-05-16), emit a counter
  // and a warn so the operator sees the regression. The seed skill's
  // palette-is-fixed clause is the primary defence; this guard is
  // the observability signal that proves whether the teaching is
  // working in production.
  //
  // CONTRACT (load-bearing): the verdict here MUST only feed metrics
  // and audit. The matcher is keyword-regex over LLM prose, which is
  // explicitly forbidden as a behavior input by
  // `feedback_no_hacks_only_root_cause.md`. Wiring this verdict into
  // any retry / abort / palette-mutation path turns observability
  // into control-flow and violates the contract — don't.
  if (signals.lastAssistantText) {
    const palette = new Set(Object.keys(tools));
    const verdict = detectToolHallucinatedAbsence({
      assistantText: signals.lastAssistantText,
      palette,
    });
    if (verdict.hallucinated && verdict.toolName) {
      recordToolHallucinatedAbsence({ tool: verdict.toolName });
      logger.warn({
        module: "conversation",
        action: "loop.tool_hallucinated_absence",
        msg: "assistant denied a tool that IS in the resolved palette this turn",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        tool: verdict.toolName,
        pattern: verdict.pattern,
      });
    }
  }

  // Critic / judge pass — terminal-step rubric over whatever the
  // turn produced (commit, propose, or chat). The critic is
  // deterministic (structural predicates against the artifact) so
  // there is no second LLM call here. Verdict is logged + emitted
  // as an event; a `priorCriticFail` signal flips on so the next
  // turn's prepareStep escalates one tier up. Re-entry on the same
  // turn is intentionally NOT done here — it would require
  // restructuring the runOnce / fallback flow and is left as a
  // follow-up.
  let criticVerdict: CriticVerdict | undefined;
  if (!cancelled && (signals.committed || signals.lastAssistantText)) {
    // Resolve resource_kind from the draft's active_target. The
    // earlier code defaulted "none" → "workflow" which gave the
    // critic a false positive on commits with no active target. Now
    // we explicitly skip critic dispatch for those.
    const activeKind = draft.summary?.active_target.kind;
    const resourceKind: "connector" | "workflow" | null =
      activeKind === "connector" || activeKind === "workflow" ? activeKind : null;

    // Count validated-checkpoint records that are ok=true. The
    // checkpoints map lives on the AuthoringState alongside the draft
    // and is updated by validate_draft / validate_connector_draft /
    // dry_run_step etc.
    const validatedStepCount = (() => {
      const cps = draft.state?.checkpoints ?? {};
      let n = 0;
      for (const key of Object.keys(cps)) {
        if (!/_validated$/.test(key)) continue;
        const cp = (cps as Record<string, { ok?: boolean | null }>)[key];
        if (cp?.ok === true) n += 1;
      }
      return n;
    })();

    // Connector-side: auth_type on the connector draft; this is the
    // mode the persisted row will carry.
    const connectorAuthMode =
      resourceKind === "connector" ? (draft.connector?.auth_type ?? null) : null;

    // Workflow-side: the first step's `kind` is the trigger semantic
    // (subkit doesn't have a separate trigger field — the first step
    // IS the entry point).
    const workflowTriggerKind =
      resourceKind === "workflow"
        ? (() => {
            const first = draft.workflow?.steps?.[0] as { kind?: unknown } | undefined;
            return typeof first?.kind === "string" ? first.kind : null;
          })()
        : null;

    const artifact: CriticArtifact | null = signals.committed
      ? resourceKind === null
        ? null
        : {
            kind: "save_workflow_draft",
            payload: {
              resource_kind: resourceKind,
              resource_id: signals.committed.workflow_id,
              connector_auth_mode: connectorAuthMode,
              workflow_trigger_kind: workflowTriggerKind,
              validated_step_count: validatedStepCount,
              committed_text: signals.lastAssistantText ?? "",
              referenced_credentials: [],
            },
          }
      : { kind: "chat", payload: signals.lastAssistantText };
    if (artifact === null) {
      // Fall through — no critic dispatch when the commit had no
      // active target (treat as a no-op rather than mis-shape an
      // artifact).
    } else {
      try {
        criticVerdict = await runCritic({
          artifact,
          ...(p.runtime_context
            ? {
                runtimeContext: {
                  ...(p.runtime_context.engine_url
                    ? { engine_url: p.runtime_context.engine_url }
                    : {}),
                  ...(p.runtime_context.tenant_slug
                    ? { tenant_slug: p.runtime_context.tenant_slug }
                    : {}),
                },
              }
            : {}),
        });
        if (criticVerdict.verdict === "fail") {
          stepRouterSignals.priorCriticFail = true;
        }
        const failedChecks = criticVerdict.checks
          ? Object.entries(criticVerdict.checks)
              .filter(([, v]) => v === false)
              .map(([k]) => k)
          : [];
        logger.info({
          module: "llm",
          action: "critic.verdict",
          msg: `critic verdict: ${criticVerdict.verdict}`,
          conversation_id: p.conversation_id,
          tenant_id: p.tenant_id,
          kind: artifact.kind,
          verdict: criticVerdict.verdict,
          confidence: criticVerdict.confidence,
          reason: criticVerdict.reason,
          failed_checks: failedChecks,
          hint: criticVerdict.hint ?? null,
          will_escalate_next_turn: criticVerdict.verdict === "fail",
          will_abstain: criticVerdict.verdict === "fail" && criticVerdict.confidence < 0.6,
        });
        // Lever 15: confidence-based abstention. When the critic's
        // confidence is below 0.6 AND the turn committed, surface an
        // `ask_user_text` elicitation that the operator must answer
        // before the conversation continues. This does NOT roll back
        // the commit (the save_workflow_draft tool already wrote the row by
        // the time the critic runs); it forces the operator to
        // explicitly confirm or revise. Rate-limited to ONE abstention
        // per turn so a flaky critic cannot spam elicitations.
        if (
          criticVerdict.verdict === "fail" &&
          criticVerdict.confidence < 0.6 &&
          signals.committed
        ) {
          try {
            const elicitation = await createElicitation(
              {
                tenant_id: p.tenant_id,
                conversation_id: p.conversation_id,
                tool_call_id: null,
                tool_name: "ask_user_text",
                summary: `low-confidence commit: ${criticVerdict.reason}`,
                input: {
                  question:
                    "The critic flagged this commit with low confidence. " +
                    `Reason: ${criticVerdict.reason}. ` +
                    `${criticVerdict.hint ? `Suggested fix: ${criticVerdict.hint}. ` : ""}` +
                    "Confirm the commit, or describe what should change.",
                  placeholder: "confirm | describe a fix",
                  metadata: {
                    source: "critic.abstention",
                    critic_kind: artifact.kind,
                    confidence: criticVerdict.confidence,
                    failed_checks: failedChecks,
                  },
                },
                actor_id: p.actor_id,
              },
              p.db,
            );
            signals.pendingChildElicitationIds.push(elicitation.id);
            events.push({
              type: "activity",
              phase: "idle",
              label: `critic abstention · ${criticVerdict.reason}`,
            });
            logger.info({
              module: "llm",
              action: "critic.abstention.elicited",
              msg: "low-confidence commit produced an ask_user_text follow-up",
              conversation_id: p.conversation_id,
              tenant_id: p.tenant_id,
              elicitation_id: elicitation.id,
              confidence: criticVerdict.confidence,
              failed_checks: failedChecks,
            });
          } catch (err) {
            logger.warn({
              module: "llm",
              action: "critic.abstention.elicit_failed",
              msg: "could not create abstention elicitation — verdict still logged",
              conversation_id: p.conversation_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        // Critic must not crash the loop — log and continue.
        logger.warn({
          module: "llm",
          action: "critic.threw",
          conversation_id: p.conversation_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } // close `else` for artifact !== null
  }

  // Resolve final status.
  let status: RunLoopResult["status"] = "active";
  let committedWorkflowId: string | undefined;
  let pendingElicitationId: string | undefined;
  const rows = await p.db
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  const persistedStatus = rows[0]?.status ?? null;
  const conversationCancelled =
    cancelled ||
    persistedStatus === "abandoned" ||
    turnAbortCtrl.signal.reason === CONVERSATION_CANCELLED_REASON;
  let completedStatus: ConversationStatus;
  if (conversationCancelled) {
    status = "abandoned";
    completedStatus = "abandoned";
  } else if (signals.committed) {
    status = "committed";
    committedWorkflowId = signals.committed.workflow_id;
    completedStatus = "committed";
  } else if (signals.pendingElicitation || persistedStatus === "awaiting_input") {
    status = "awaiting_input";
    pendingElicitationId = signals.pendingElicitation?.elicitation_id;
    completedStatus = "awaiting_input";
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
    completedStatus = "active";
  }

  // Attach turn usage to the `completed` frame (sk status-line
  // reads `turn_tokens` + `remaining_monthly_budget_tokens`). The
  // optional `breakdown` carries the per-section token shape from
  // the assembled prompt so the spinner / `/cost` view can show
  // skills 4.2k · transcript 6.1k · docs 2.0k · total 14.5k.
  //
  // Compute usage BEFORE pushing the frame so live SSE emits the
  // payload-complete event in one go. Mutating array entries after
  // a buffered push doesn't re-fire the live emitter.
  const usageAfter = await monthlyUsage(p.tenant_id, p.db).catch(() => usageBefore);
  const turnTokens = Math.max(0, usageAfter - usageBefore);
  const remaining =
    route.monthly_budget != null ? Math.max(0, route.monthly_budget - usageAfter) : null;
  const breakdown = prompt?.token_counts
    ? {
        system: prompt.token_counts.system,
        skills: prompt.token_counts.skills,
        knowledge: prompt.token_counts.knowledge,
        docs: prompt.token_counts.docs,
        failures: prompt.token_counts.failures,
        messages: prompt.token_counts.messages,
        recipe_bodies: prompt.token_counts.recipe_bodies,
        skill_candidates: prompt.token_counts.skill_candidates,
        prior_workflows: prompt.token_counts.prior_workflows,
        total: prompt.token_counts.total,
      }
    : undefined;
  events.push({
    type: "completed",
    status: completedStatus,
    usage: {
      turn_tokens: turnTokens,
      // Honest cost split (see the accumulator comment near turn
      // start): `prompt_tokens_last_call` is the only figure that is
      // comparable to `context_cap_tokens`; `turn_tokens_total` is the
      // cumulative spend across every LLM call of this turn.
      ...(promptTokensLastCall != null ? { prompt_tokens_last_call: promptTokensLastCall } : {}),
      turn_tokens_total: turnTokensTotal,
      remaining_monthly_budget_tokens: remaining,
      context_cap_tokens: contextCap,
      ...(breakdown ? { breakdown } : {}),
    },
  });

  // Next-message suggestion frame. Always emitted (suggestion may be
  // null) so the SSE close is deterministic — sk-cli relies on the
  // frame's presence to decide whether to clear ghost state. The
  // emitter is wrapped in its own try/catch so a flaky model can
  // never take down the parent turn.
  //
  // Abandoned turns: short-circuit with a `turn-abandoned` frame
  // instead of running offer-parse over partial / cancelled
  // assistant prose. The model fallback would always miss anyway and
  // burn tokens for nothing.
  //
  // budget_guard: when the tenant has a monthly budget, refuse the
  // model fallback if the post-turn usage is already within
  // SUGGEST_BUDGET_HEADROOM_TOKENS of the cap. Offer-parse fast path
  // is unaffected — it costs zero tokens and still fires.
  //
  // loaded_skills: production wiring of the skill-aware slash variant
  // is deferred — the engine stores skill slugs only, and the
  // offer-skill path needs per-skill verb metadata that doesn't yet
  // exist in the data model. The text-mode offer-parse still works
  // for skills (matched action becomes plain user input). Adding
  // verbs to the skills schema lights up `/skill <slug> <verb>`
  // suggestions without further loop changes.
  // `LoadedSkillHint.verbs` is unused in production today (covered by
  // unit tests only). When Skill records carry a `verbs: string[]`
  // field, thread `loaded_skills: loadedSkills.map(slug => ({ slug,
  // verbs }))` here so the offer-skill slash variant can resolve.
  let suggestionFrame: TurnEvent;
  if (completedStatus === "abandoned") {
    suggestionFrame = nextSuggestion({
      suggestion: null,
      reason: "turn-abandoned",
      kind: null,
    });
  } else {
    const SUGGEST_BUDGET_HEADROOM_TOKENS = 200;
    const monthlyBudget = route.monthly_budget;
    const budgetGuard =
      monthlyBudget != null && monthlyBudget > 0
        ? () => usageAfter + SUGGEST_BUDGET_HEADROOM_TOKENS <= monthlyBudget
        : undefined;
    suggestionFrame = await buildNextSuggestionFrame({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      events,
      // Pass `db` so the emitter loads multi-turn persisted history
      // for the model fallback prompt instead of being limited to
      // the per-turn events buffer.
      db: p.db,
      ...(p.next_suggestion_suppress !== undefined
        ? { client_suppress: p.next_suggestion_suppress }
        : {}),
      ...(budgetGuard ? { budget_guard: budgetGuard } : {}),
    });
  }
  events.push(suggestionFrame);

  // P6: emit a per-turn token-usage log line so the operator can grep
  // engine logs alone (without enabling client-side debug output) to
  // see which validation/preview cycles burned how many tokens. The
  // CLI already gets the same breakdown via the `completed` event;
  // this is the symmetric server-side record.
  //
  // Additionally surface the top-N heaviest included skills so when
  // a turn balloons past expectation (the dca36b29 session showed
  // breakdown_skills=26661 — ~27k tokens of skill bodies — without
  // a way to see WHICH skills) operators can identify the heavy
  // contributors and trim them. Pre-fix this required reading the
  // included_skill_ids list and looking up each skill body by hand.
  const topSkillBreakdown = (() => {
    if (!prompt) return null;
    const skills = prompt.included_skills ?? [];
    if (skills.length === 0) return null;
    const weighed = skills.map((s) => ({
      id: s.id,
      slug: s.slug ?? null,
      title: s.title ?? null,
      tokens: prompt.token_counts ? Math.round(prompt.token_counts.skills / skills.length) : 0,
    }));
    // Recompute per-skill weights using countTokens so the report
    // is accurate — the sum-divided-by-count above is just a fallback
    // when a per-skill counter isn't wired up yet.
    try {
      for (const w of weighed) {
        const skill = skills.find((s) => s.id === w.id);
        if (skill) {
          w.tokens = countSkillTokens(skill, p.runtime_context);
        }
      }
    } catch {
      // best-effort — token counter failures must not block turn end
    }
    return weighed
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5)
      .map((w) => ({
        ...(w.slug ? { slug: w.slug } : { id: w.id }),
        tokens: w.tokens,
      }));
  })();
  logger.info({
    module: "conversation",
    action: "dialog.turn_end",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    final_status: status,
    turn_tokens: turnTokens,
    remaining_monthly_budget_tokens: remaining,
    ...(breakdown
      ? {
          breakdown_system: breakdown.system,
          breakdown_skills: breakdown.skills,
          breakdown_knowledge: breakdown.knowledge,
          breakdown_docs: breakdown.docs,
          breakdown_failures: breakdown.failures,
          breakdown_messages: breakdown.messages,
          breakdown_recipe_bodies: breakdown.recipe_bodies,
          breakdown_skill_candidates: breakdown.skill_candidates,
          breakdown_total: breakdown.total,
        }
      : {}),
    ...(topSkillBreakdown ? { top_skills_by_tokens: topSkillBreakdown } : {}),
  });

  const out: RunLoopResult = { events, status };
  if (committedWorkflowId) out.committed_workflow_id = committedWorkflowId;
  if (pendingElicitationId) out.pending_elicitation_id = pendingElicitationId;
  // Per-turn GC hint. Production evidence: the cgroup hit MemoryHigh
  // 1967 times in 12 h on the engine droplet at idle (peak 6.34 GB,
  // current never drops below 2.79 GB). Bun's JSC arenas do not
  // proactively return memory after a multi-GB turn unless major GC
  // fires, and major-GC heuristics don't trigger again until the next
  // allocation pushes them. A synchronous full GC right after
  // `dialog.turn_end` (~5-20 ms on a multi-GB heap; in the noise vs.
  // the turn cost) lets `memory.current` fall back toward boot
  // baseline between turns instead of staying elevated.
  //
  // Drop the strong refs on the largest closure-captured allocations
  // first so the upcoming GC pass can reclaim them in one cycle.
  // `wrappedTools` is the ~109-tool palette built per turn; the loop
  // closure was the last live reference, but clearing it explicitly
  // removes ambiguity for the optimizer.
  for (const key of Object.keys(wrappedTools)) {
    delete (wrappedTools as Record<string, unknown>)[key];
  }
  // NO manual GC hint — not even the async variant. Live profiling
  // (memory.sample) showed each turn allocates ~700MB of EXTERNAL native
  // memory; forcing a collection over that churn every turn produced
  // multi-second pauses that surfaced as event_loop.lag with no slow
  // phase attributed (GC pauses appear in no phase). JSC schedules its
  // own collections far better against an allocation-heavy workload; the
  // explicit-ref drop above is what actually makes the palette
  // reclaimable. The remaining work is reducing the per-turn external
  // allocation itself (provider stream buffers / prompt copies), tracked
  // as the open headroom item.
  return out;
}
