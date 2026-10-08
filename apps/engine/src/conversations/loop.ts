import { hasToolCall, type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { and, desc, eq, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
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
import {
  promptCacheSupported,
  splitPromptIntoBlocks,
  toSystemMessages,
} from "../llm/core/cache-blocks.ts";
import {
  assembleEnhancedPrompt,
  countSkillTokens,
  detectIntentSkills,
} from "../llm/core/context-assembler.ts";
import { recordConversationBudgetReport } from "../llm/core/conversation-budget-report.ts";
import { resolveModelRoute } from "../llm/core/invoke.ts";
import { anthropicWebSearchApplies, buildAnthropicWebSearchTool } from "../llm/core/model-init.ts";
import { repairToolCall as repairToolCallHandler } from "../llm/core/repair-tool-call.ts";
import { PROVIDER_RESPONSE_TIMEOUT_MS } from "../llm/core/response-timeout.ts";
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
  shouldFallBack,
  toLlmProviderError,
} from "../llm/provider-errors.ts";
import { engineUrlFromConfig } from "../llm/runtime-context.ts";
import { log, logger } from "../logging/logger.ts";
import {
  recordConversationRepair,
  recordConversationStep,
  recordLlmQuotaExhausted,
  recordLlmStepTimeout,
  recordLlmTokens,
  recordToolHallucinatedAbsence,
} from "../observability/instrumentation.ts";
import { readMemoryUsage, timePhase, timePhaseAsync } from "../observability/runtime-telemetry.ts";
import { enrichActiveSpan, isTracingActive, toolSpanAttributes } from "../observability/tracing.ts";
import { skillAudienceForAuthoringMode } from "../skills/types.ts";
import { now } from "../utils/clock.ts";
import { CONVERSATION_CANCELLED_REASON, isExpectedCancellation } from "./abort.ts";
import { resolveAttachmentSlugsInText } from "./attachments.ts";
import { expandPriorFailuresFromToolCalls } from "./authoring-critic/prior-failures.ts";
import { hasInProgressWorkflowDraft, startNewWorkflowDraft } from "./authoring-state.ts";
import { renderAutomationContext } from "./automation-context.ts";
import { type Citation, harvestCitations } from "./citations.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import type { ElicitationBridge } from "./elicitation-bridge.ts";
import { createElicitation, setElicitationParentMessage } from "./elicitations.ts";
import { EventSink } from "./event-sink.ts";
import {
  detectMultiArtifactIntent,
  detectUserIntent,
  inferStateDrivenFollowUpTool,
  matchesEnumerationIntent,
  NO_SNAPSHOT_COVERAGE,
  resolvePreferredTool,
  turnToolChoice,
} from "./intent-detector.ts";
import { RUN_VERB_RE } from "./intent-patterns.ts";
import { abstentionDecision } from "./loop/abstention-gate.ts";
import { resolveConversationAttemptRoutes } from "./loop/attempt-route.ts";
import { loadEnumerationCoverage } from "./loop/enumeration-coverage.ts";
import {
  answeringModelLabel,
  DEFAULT_BUDGET,
  MAX_REPAIRS_PER_TURN,
  resolveLanguageModel,
} from "./loop/model-resolver.ts";
import { applyRecency, parseLoadedSkills } from "./loop/skill-recency.ts";
import {
  abstainedStopCondition,
  automationReviewStopCondition,
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
import { closingProseQuestion } from "./prose-question.ts";
import {
  type ConversationReference,
  markLatestUserMessageUnresolvedReferences,
  resolveReferences,
} from "./references.ts";
import { resolveScopeFactsForConversation } from "./scope-facts.ts";
import { compactConversation } from "./service/compact.ts";
import {
  autoloadForUserTurn,
  listBaselineSlugs,
  loadActivationCatalog,
  reaffirmLoadedForTurn,
} from "./skill-autoload.ts";
import { checkSourceFaithful, keepResolvableCitations } from "./source-faithful.ts";
import { nextSuggestion } from "./streaming.ts";
import { elideWithinTurnToolOutputs } from "./tool-output-elision.ts";
import {
  applyExecutionToolGate,
  collectSyntheticWorkflowSlugs,
  type ExecutionToolGateDecision,
  resolveExecutionToolGate,
  resolveNamedWorkflowSlug,
} from "./tools/authoring-palette.ts";
import { listTools, type ToolContext } from "./tools/index.ts";
import { type TurnSignals, wrapTools } from "./tools/sdk-wrap.ts";
import { LlmTimeoutError, timeoutBudgetOf, timeoutPhaseOf } from "./turn-failure.ts";
import { classifyFallbackSynthesis, turnLoopBudgetStopCondition } from "./turn-helpers.ts";
import type { ConversationStatus, DraftDocument, TurnEvent } from "./types.ts";

export const CONVERSE_FIRST_CHUNK_TIMEOUT_MS = PROVIDER_RESPONSE_TIMEOUT_MS;

let firstChunkTimeoutMsOverride: number | null = null;
export function _setConverseFirstChunkTimeoutMsForTests(ms: number | null): void {
  firstChunkTimeoutMsOverride = ms;
}

export interface RunLoopParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal?: ResolvedPrincipal | null;
  connector_id: string | null;
  workflow_id: string | null;
  user_message: string | null;
  user_references?: ConversationReference[] | null;
  step_budget?: number;
  user_memory?: string | null;
  model_override?: string | null;
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  onEvent?: (ev: TurnEvent) => void;
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  turn_abort_ctrl: AbortController;
  user_message_persisted?: boolean;
  next_suggestion_suppress?: boolean;
  elicitationBridge?: ElicitationBridge;
}

export interface RunLoopResult {
  events: TurnEvent[];
  status: "awaiting_input" | "committed" | "active" | "abandoned" | "exhausted";
  committed_workflow_id?: string;
  pending_elicitation_id?: string;
}

export async function runLoop(p: RunLoopParams): Promise<RunLoopResult> {
  const sink = new EventSink(p.onEvent);
  const events: TurnEvent[] = sink.asArrayProxy();
  const budget = p.step_budget ?? DEFAULT_BUDGET;
  const resolvedEngineUrl = p.runtime_context?.engine_url ?? engineUrlFromConfig();
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

  let promptTokensLastCall: number | null = null;
  let turnTokensTotal = 0;
  let turnInputTokens = 0;
  let turnCacheReadTokens = 0;

  let ingestedUserMessage: string | null = p.user_message;
  if (p.user_message) {
    const rewrite = await resolveAttachmentSlugsInText(p.user_message, {
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      ...(p.principal !== undefined ? { principal: p.principal } : {}),
    });
    ingestedUserMessage = rewrite.text;
    if (!p.user_message_persisted) {
      await appendMessage(p.db, p.tenant_id, p.conversation_id, "user", {
        text: ingestedUserMessage,
        ...(p.user_references && p.user_references.length > 0
          ? { references: p.user_references }
          : {}),
      });
    }
    events.push({ type: "message", role: "user", content: { text: ingestedUserMessage } });
  }

  const referenced = await resolveReferences(p.user_references, {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    principal: p.principal,
  });
  if (referenced.unresolved.length > 0) {
    await markLatestUserMessageUnresolvedReferences(
      p.db,
      p.tenant_id,
      p.conversation_id,
      referenced.unresolved,
    );
  }

  const detectedIntent = detectUserIntent(
    ingestedUserMessage,
    matchesEnumerationIntent(ingestedUserMessage)
      ? p.principal
        ? await loadEnumerationCoverage(p.principal, ingestedUserMessage, p.db)
        : NO_SNAPSHOT_COVERAGE
      : undefined,
  );
  let workflowIdForTurn = p.workflow_id;

  let draft: DraftDocument = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  const hasBoundSavedWorkflow =
    workflowIdForTurn !== null ||
    draft.summary?.active_target.kind === "workflow" ||
    draft.summary?.persisted_resources.some((resource) => resource.kind === "workflow") === true;
  if (
    detectedIntent.startNewWorkflow === true &&
    hasBoundSavedWorkflow &&
    !hasInProgressWorkflowDraft(draft)
  ) {
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
    ...(p.surface ? { surface: p.surface } : {}),
    engineClient: new EngineClient({
      tenant_id: p.tenant_id,
      actor_id: p.actor_id,
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
    ...(p.elicitationBridge ? { elicitationBridge: p.elicitationBridge } : {}),
  };

  const route = await resolveModelRoute(p.tenant_id, p.db);
  const seedModel = p.model_override ?? route.primary;

  const stepRouterSignals: StepRouterSignals = {
    hadRepairThisTurn: false,
    strongRunIntent:
      detectedIntent.forceTool === "run_workflow" ||
      detectedIntent.forceTool === "save_workflow_draft",
    multiArtifactIntent: detectMultiArtifactIntent(ingestedUserMessage),
    priorCriticFail: false,
    ...(p.surface ? { surface: p.surface } : {}),
  };

  const currentUserText = ingestedUserMessage ?? "continue";
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
    hasFailedExecution = failed.length > 0;
  }
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
    const audience = skillAudienceForAuthoringMode(draft.summary?.mode);
    const reaffirmed = reaffirmLoadedForTurn(
      {
        mode: "user_turn",
        user_text: currentUserText,
        connector_drivers: scope.connector_drivers,
        connector_templates: scope.connector_templates,
        surface: p.surface,
        audience,
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
        surface: p.surface,
        audience,
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
  await p.db
    .update(conversations)
    .set({ loaded_skills: recency.next })
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)));
  const explicitSkillSlugs = recency.fullBodySet;
  const loadedSlugMembership = recency.membership;
  const loadedSkillSlugs = [...new Set([...explicitSkillSlugs, ...intentSkillSlugs])];

  let documentAnalysisSummary: {
    source: string;
    confidence: number;
    endpoint_count: number;
    sample_endpoints: Array<{ method: string; path: string; description?: string }>;
  } | null = null;
  const activeConnectorId = p.connector_id ?? convRow[0]?.target_connector_id ?? null;
  if (activeConnectorId) {
    const epRows = await p.db
      .select({
        method: connectorEndpointSchemas.method,
        path: connectorEndpointSchemas.path,
        description: connectorEndpointSchemas.description,
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
        sample_endpoints: epRows.map((r) => ({
          method: r.method,
          path: r.path,
          ...(r.description ? { description: r.description } : {}),
        })),
      };
    }
  }
  const automationContext = await renderAutomationContext(
    p.tenant_id,
    workflowIdForTurn ??
      (draft.summary?.active_target.kind === "workflow"
        ? draft.summary.active_target.id
        : undefined),
    p.principal,
    p.db,
  );
  const authoringContext = [
    renderAuthoringContextBlock({
      draft,
      user_message: currentUserText,
      document_analysis: documentAnalysisSummary,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
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
  const runVerbBiasFires = (() => {
    if (!currentUserText) return false;
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
  const previewWarnings = draft.latest_preview?.warnings ?? [];
  const priorFailuresFromPreview =
    previewWarnings.length > 0
      ? previewWarnings.slice(0, 10).map((w) => ({
          step_id: w.step_key ?? "preview",
          error: `dry-run warning ${w.code ?? "unknown"}: ${w.message ?? ""}`,
        }))
      : [];

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
        model: seedModel,
        ...(p.user_memory ? { user_memory: p.user_memory } : {}),
        ...(loadedSkillSlugs.length > 0 ? { loaded_skill_slugs: loadedSkillSlugs } : {}),
        ...(loadedSlugMembership.length > 0
          ? { loaded_skill_membership: loadedSlugMembership }
          : {}),
        ...(p.surface ? { surface: p.surface } : {}),
        ...(authoringContext ? { authoring_context: authoringContext } : {}),
        ...(automationContext ? { automation_context: automationContext } : {}),
        ...(p.principal ? { principal: p.principal } : {}),
        ...(authoringHint ? { authoring_hint: authoringHint } : {}),
        ...(authoringConnectorIds.length > 0
          ? { authoring_connector_ids: authoringConnectorIds }
          : {}),
        ...(combinedPriorFailures.length > 0 ? { prior_failures: combinedPriorFailures } : {}),
        ...(referenced.block && referenced.trim_ref
          ? { referenced_entities: { block: referenced.block, trim_ref: referenced.trim_ref } }
          : {}),
        conversation_id: p.conversation_id,
        ...(() => {
          const rc = {
            ...(resolvedEngineUrl ? { engine_url: resolvedEngineUrl } : {}),
            ...(p.runtime_context?.tenant_slug
              ? { tenant_slug: p.runtime_context.tenant_slug }
              : {}),
            ...(p.runtime_context?.actor_email
              ? { actor_email: p.runtime_context.actor_email }
              : {}),
            ...(p.runtime_context?.actor_role ? { actor_role: p.runtime_context.actor_role } : {}),
            ...(p.surface ? { surface: p.surface } : {}),
            ...(p.permission_mode ? { permission_mode: p.permission_mode } : {}),
          };
          return Object.keys(rc).length > 0 ? { runtime_context: rc } : {};
        })(),
      },
      p.db,
    ),
  );
  let messages = await timePhaseAsync("converse.build_model_messages", () =>
    buildModelMessages(p.db, p.tenant_id, p.conversation_id, {
      conversationEnvelope: true,
      conversation_id: p.conversation_id,
    }),
  );
  let messageTokens = timePhase("converse.count_message_tokens", () =>
    countModelMessagesTokens(messages),
  );
  let estimatedPromptTokens = prompt.token_counts.total + messageTokens;
  let estimated = estimatedPromptTokens + budget * 1024;

  const contextCap = contextCapFor(seedModel);
  recordConversationBudgetReport(p.tenant_id, p.conversation_id, {
    cap_tokens: Math.min(route.context_cap, contextCap),
    total_tokens: prompt.token_counts.total,
    dropped_sections: prompt.dropped_sections,
    assembled_at: new Date().toISOString(),
  });
  if (estimatedPromptTokens > contextCap) {
    const compaction = await compactConversation(
      { tenant_id: p.tenant_id, conversation_id: p.conversation_id, actor_id: p.actor_id },
      p.db,
    );
    if (compaction.messages_collapsed > 0) {
      messages = await buildModelMessages(p.db, p.tenant_id, p.conversation_id, {
        conversationEnvelope: true,
        conversation_id: p.conversation_id,
      });
      messageTokens = countModelMessagesTokens(messages);
      const before = estimatedPromptTokens;
      estimatedPromptTokens = prompt.token_counts.total + messageTokens;
      estimated = estimatedPromptTokens + budget * 1024;
      logger.warn({
        module: "conversation",
        action: "preflight.context_auto_compacted",
        msg: "assembled prompt exceeded the context cap; auto-compacted the conversation and retried",
        conversation_id: p.conversation_id,
        tenant_id: p.tenant_id,
        model: seedModel,
        messages_collapsed: compaction.messages_collapsed,
        estimated_prompt_tokens_before: before,
        estimated_prompt_tokens_after: estimatedPromptTokens,
        context_cap: contextCap,
      });
    }
    if (estimatedPromptTokens > contextCap) {
      logger.warn({
        module: "conversation",
        action: "preflight.context_too_large",
        msg: "rejecting turn before provider call — assembled prompt exceeds context cap even after compaction",
        conversation_id: p.conversation_id,
        tenant_id: p.tenant_id,
        model: seedModel,
        estimated_prompt_tokens: estimatedPromptTokens,
        context_cap: contextCap,
        message_tokens: messageTokens,
        prompt_breakdown: prompt.token_counts,
        compacted: compaction.messages_collapsed > 0,
      });
      throw new LlmContextTooLarge("llm_context_too_large", {
        estimated_prompt_tokens: estimatedPromptTokens,
        context_cap: contextCap,
        message_tokens: messageTokens,
        prompt_total: prompt.token_counts.total,
        model: seedModel,
        remediation: "compact_or_resume",
      });
    }
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
          model: seedModel,
          prompt_tokens: estimatedPromptTokens,
          completion_tokens: 0,
          latency_ms: 0,
          result: "quota_exhausted",
          error: "llm_quota_exhausted",
          conversation_id: p.conversation_id,
          ...actor,
        },
        p.db,
      );
      recordLlmQuotaExhausted({ tenant_id: p.tenant_id });
    }
    throw err;
  }

  const AUTO_LOADED_AUTHORING_SKILLS: ReadonlyArray<string> = [
    "connector-creation-guidance",
    "workflow-authoring",
  ];
  const loadedSkills =
    p.surface === "chat"
      ? [...loadedSlugMembership]
      : [...new Set([...loadedSlugMembership, ...AUTO_LOADED_AUTHORING_SKILLS])];
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

  const tools = wrappedTools;

  const syntheticWorkflowSlugs = collectSyntheticWorkflowSlugs(Object.keys(tools));
  const hasBoundSavedWorkflowTarget =
    workflowIdForTurn !== null ||
    (draft.summary?.active_target.kind === "workflow" &&
      draft.summary?.active_target.lifecycle_state === "persisted");
  const namedWorkflowSlug = resolveNamedWorkflowSlug(ingestedUserMessage, syntheticWorkflowSlugs);
  const executionGate: ExecutionToolGateDecision =
    p.surface === "chat"
      ? { exposeExecution: true, reason: "chat_surface" }
      : detectedIntent.suppressExecution === true
        ? { exposeExecution: false, reason: "explicit_no_run" }
        : resolveExecutionToolGate({
            hasBoundSavedWorkflow: hasBoundSavedWorkflowTarget,
            explicitlyNamedWorkflowSlug: namedWorkflowSlug,
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
      msg: "execution tools removed from this turn's palette",
      conversation_id: p.conversation_id,
      reason: executionGate.reason,
      removed_count: removedExecutionTools,
    });
  }

  const stateDrivenTool = inferStateDrivenFollowUpTool({
    latestUserText: ingestedUserMessage,
    permission_mode: p.permission_mode ?? null,
    summary: draft.summary,
  });
  const preferredTool = resolvePreferredTool(
    detectedIntent,
    stateDrivenTool,
    (name) => tools[name] !== undefined,
  );
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

  async function runOnce(
    modelId: string,
    attemptProvider: typeof route.provider,
    prebuiltMessages?: ModelMessage[],
  ): Promise<void> {
    let lastStepEnd = now();
    let activeStepModel = modelId;
    let turnRepairCount = 0;
    const attemptMessages =
      prebuiltMessages ??
      (await buildModelMessages(p.db, p.tenant_id, p.conversation_id, {
        conversationEnvelope: true,
        conversation_id: p.conversation_id,
      }));
    let capturedError: unknown;
    const resolvedModel = await resolveLanguageModel(attemptProvider, modelId, p.tenant_id);
    const turnBudgetMs = Math.min(10 * 60_000, 30_000 * budget);
    const firstChunkTimeoutMs = firstChunkTimeoutMsOverride ?? CONVERSE_FIRST_CHUNK_TIMEOUT_MS;
    const streamStartedAt = now();
    const streamTimeout: { error: LlmTimeoutError | null } = { error: null };
    const cacheSupported = promptCacheSupported(attemptProvider, modelId);
    const cacheBlocks = timePhase("converse.split_cache_blocks", () =>
      splitPromptIntoBlocks(prompt, "converse"),
    );
    const systemMessages = toSystemMessages(cacheBlocks, {
      enabled: cacheSupported,
      ttl: "1h",
    });
    events.push({
      type: "activity",
      phase: "composing",
      label: "composing reply",
    });
    const toolsByName: Record<string, import("./tools/index.ts").ConversationTool> = {};
    for (const t of listTools()) toolsByName[t.name] = t;

    const turnStageReadOnly = false;
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
      return supportsExtendedThinking(attemptProvider, modelId);
    })();
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
      provider: attemptProvider,
      model: modelId,
      stage: draft.summary?.stage ?? "idle",
      parallel_tools_enabled: turnStageReadOnly,
      extended_thinking_enabled: thinkingThisTurn,
      thinking_suppressed_by_forced_tool: thinkingDecision.suppressedByForcedTool,
      cache_supported: cacheSupported,
    });
    const webSearchSetting = (() => {
      try {
        return getConfig(p.tenant_id).llm.web_search === true;
      } catch {
        return false;
      }
    })();
    const webSearchEnabled = anthropicWebSearchApplies(attemptProvider, modelId, webSearchSetting);
    const turnTools: ToolSet = webSearchEnabled
      ? { ...tools, web_search: buildAnthropicWebSearchTool(5) }
      : tools;
    const result = streamText({
      model: resolvedModel,
      instructions: systemMessages,
      messages: attemptMessages,
      allowSystemInMessages: true,
      tools: turnTools,
      toolChoice: turnToolChoice(preferredTool, forceNoTools),
      reasoning: thinkingThisTurn ? "high" : "none",
      ...(cacheSupported
        ? {
            providerOptions: {
              anthropic: {
                disableParallelToolUse: !turnStageReadOnly,
              },
            },
          }
        : {}),
      experimental_repairToolCall: ({
        toolCall,
        tools: callTools,
        error,
        messages: callMessages,
        system: callSystem,
      }) => {
        if (turnRepairCount >= MAX_REPAIRS_PER_TURN) {
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
        turnRepairCount += 1;
        return repairToolCallHandler({
          toolCall,
          tools: callTools,
          messages: callMessages,
          system: callSystem,
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
      prepareStep: async ({ stepNumber, steps, messages: stepMessages, model: stepModel }) =>
        timePhaseAsync("converse.prepare_step", async () => {
          activeStepModel = modelId;
          {
            const m = readMemoryUsage();
            logger.info({
              module: "process",
              action: "step.memory",
              at: "prepare",
              step_number: stepNumber,
              external_mb: Math.round(m.external / (1024 * 1024)),
              rss_mb: Math.round(m.rss / (1024 * 1024)),
            });
          }
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
            provider: attemptProvider,
            toolsByName,
            paletteToolNames: Object.keys(tools),
            signals: stepRouterSignals,
            turnThinkingEnabled: thinkingThisTurn,
            forcedTool: preferredTool,
          });
          if (!decision) return elision ? { messages: elision.messages } : {};
          const result: Record<string, unknown> = elision ? { messages: elision.messages } : {};
          if (decision.modelId && decision.modelId !== modelId) {
            try {
              result.model = await resolveLanguageModel(
                attemptProvider,
                decision.modelId,
                p.tenant_id,
              );
              activeStepModel = decision.modelId;
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
                provider: attemptProvider,
                target: decision.modelId,
                fallback_model: modelId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (!forceNoTools && decision.toolChoice !== undefined)
            result.toolChoice = decision.toolChoice;
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
        abstainedStopCondition,
        pausedStopCondition,
        automationReviewStopCondition,
        committedStopCondition,
        turnLoopBudgetStopCondition,
        noProgressRepairStopCondition,
      ],
      maxRetries: 2,
      abortSignal: turnAbortCtrl.signal,
      timeout: { totalMs: turnBudgetMs, firstChunkMs: firstChunkTimeoutMs },
      onAbort: (event) => {
        if (turnAbortCtrl.signal.aborted || streamTimeout.error) return;
        const reason = (event as { reason?: unknown }).reason;
        const phase =
          timeoutPhaseOf(reason) ??
          (now() - streamStartedAt >= turnBudgetMs ? "total" : "first_chunk");
        const timeoutMs = phase === "first_chunk" ? firstChunkTimeoutMs : turnBudgetMs;
        streamTimeout.error = new LlmTimeoutError(phase, timeoutMs, { cause: reason });
        recordLlmStepTimeout({ phase });
        logger.warn({
          module: "llm",
          action: "converse.timeout",
          msg: "stream aborted by the typed SDK timeout",
          conversation_id: p.conversation_id,
          tenant_id: p.tenant_id,
          provider: attemptProvider,
          model: modelId,
          phase,
          timeout_ms: timeoutMs,
          elapsed_ms: Math.round(now() - streamStartedAt),
        });
      },
      onStepStart: ({ modelId: stepModelId }) => {
        recordConversationStep({ stage: stepRouterSignals.stage ?? "idle", model: stepModelId });
      },
      onToolExecutionEnd: ({ toolExecutionMs }) => {
        enrichActiveSpan(toolSpanAttributes({ duration_ms: toolExecutionMs }));
      },
      runtimeContext: {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        provider: attemptProvider,
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
        if (!capturedError) capturedError = error;
      },
      onStepFinish: async (step) =>
        timePhaseAsync("converse.on_step_finish", async () => {
          {
            const m = readMemoryUsage();
            const external_mb = Math.round(m.external / (1024 * 1024));
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
              } catch {}
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
          promptTokensLastCall = stepPromptTokens(u);
          turnTokensTotal += stepTotalTokens(u);
          turnInputTokens += u.inputTokens;
          turnCacheReadTokens += u.cacheReadTokens;
          const stepEndedAt = now();
          const latency_ms = Math.max(0, stepEndedAt - lastStepEnd);
          lastStepEnd = stepEndedAt;
          await recordUsage(
            {
              tenant_id: p.tenant_id,
              flow: "converse",
              model: activeStepModel,
              prompt_tokens: u.inputTokens,
              completion_tokens: u.outputTokens,
              cache_read_tokens: u.cacheReadTokens,
              cache_creation_tokens: u.cacheCreationTokens,
              latency_ms,
              result: "success",
              conversation_id: p.conversation_id,
              ...actorFields(p.principal),
            },
            p.db,
          );
          recordLlmTokens({
            tenant_id: p.tenant_id,
            model: activeStepModel,
            flow: "converse",
            prompt_tokens: u.inputTokens,
            completion_tokens: u.outputTokens,
          });
          const hasText = !!step.text && step.text.length > 0;
          const hasPendingChildren =
            signals.pendingChildToolCallIds.length > 0 ||
            signals.pendingChildElicitationIds.length > 0;
          if (hasText || hasPendingChildren) {
            const guarded = hasText
              ? runOutputGuard(step.text, {
                  ...(resolvedEngineUrl ? { engine_url: resolvedEngineUrl } : {}),
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
                { model: answeringModelLabel(attemptProvider, activeStepModel) },
              ));
            if (signals.assistantMessageId) {
              await updateMessageContent(p.db, assistantMessageId, assistantContent, {
                model: answeringModelLabel(attemptProvider, activeStepModel),
              });
            }
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
            signals.lastAssistantMessageId = assistantMessageId;
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
      const deltaScrubber = createStreamScrubber();
      try {
        const PROSE_TAIL_WINDOW = 4096;
        const PARA_RE = /\n\s*\n/g;
        let proseTail = "";
        let paragraphsEmitted = 0;
        let proseScanFrom = 0;
        for await (const chunk of result.textStream) {
          if (chunk.length === 0) continue;
          stopHeartbeat();
          const safeDelta = deltaScrubber.push(chunk);
          if (safeDelta) events.push({ type: "text_delta", text: safeDelta });
          const prevLen = proseTail.length;
          proseTail = (proseTail + chunk).slice(-PROSE_TAIL_WINDOW);
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
            const latestParagraph = proseTail.slice(0, match.index);
            if (latestParagraph) {
              runOutputGuardStream(latestParagraph, {
                ...(resolvedEngineUrl ? { engine_url: resolvedEngineUrl } : {}),
                ...(p.runtime_context?.tenant_slug
                  ? { tenant_slug: p.runtime_context.tenant_slug }
                  : {}),
              });
            }
          }
        }
      } catch {
      } finally {
        const tailDelta = deltaScrubber.flush();
        if (tailDelta) events.push({ type: "text_delta", text: tailDelta });
        stopHeartbeat();
      }
      await result.finishReason;
    } catch (err) {
      if (streamTimeout.error) throw streamTimeout.error;
      const thrown = capturedError ?? err;
      const phase = thrown instanceof LlmTimeoutError ? null : timeoutPhaseOf(thrown);
      if (phase) {
        recordLlmStepTimeout({ phase });
        const budget =
          timeoutBudgetOf(thrown) ??
          (phase === "total" ? turnBudgetMs : phase === "first_chunk" ? firstChunkTimeoutMs : null);
        if (budget !== null) throw new LlmTimeoutError(phase, budget, { cause: thrown });
      }
      throw thrown;
    }
    if (streamTimeout.error) throw streamTimeout.error;
  }

  const attempts = resolveConversationAttemptRoutes(route, seedModel);
  let cancelled = false;
  try {
    await runOnce(attempts.primary.model, attempts.primary.provider, messages);
  } catch (primaryErr) {
    if (isExpectedCancellation(primaryErr, turnAbortCtrl.signal)) {
      cancelled = true;
    } else {
      const providerKind = classifyProviderError(primaryErr);
      const providerErr =
        providerKind === "other" || primaryErr instanceof LlmTimeoutError
          ? null
          : toLlmProviderError(primaryErr);
      const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      logger.warn({
        module: "llm",
        action: "converse.failed",
        msg: "streamText primary error",
        conversation_id: p.conversation_id,
        model: seedModel,
        kind: providerErr?.kind ?? providerKind,
        error: msg,
      });
      await recordUsage(
        {
          tenant_id: p.tenant_id,
          flow: "converse",
          model: seedModel,
          prompt_tokens: estimatedPromptTokens,
          completion_tokens: 0,
          latency_ms: 0,
          result: "error",
          error: msg,
          conversation_id: p.conversation_id,
          ...actorFields(p.principal),
        },
        p.db,
      );
      if (
        !providerErr ||
        route.fallback === seedModel ||
        !shouldFallBack(primaryErr, route.provider, route.fallback_provider)
      ) {
        throw providerErr ?? primaryErr;
      }
      logger.warn({
        module: "llm",
        action: "fallback.triggered",
        msg: "llm fallback engaged",
        flow: "converse",
        conversation_id: p.conversation_id,
        primary: seedModel,
        fallback: route.fallback,
        kind: providerErr.kind,
      });
      try {
        await runOnce(attempts.fallback.model, attempts.fallback.provider);
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
              conversation_id: p.conversation_id,
              ...actorFields(p.principal),
            },
            p.db,
          );
          const typedFallbackErr =
            classifyProviderError(fbErr) === "other" || fbErr instanceof LlmTimeoutError
              ? null
              : toLlmProviderError(fbErr);
          throw typedFallbackErr ?? fbErr;
        }
      }
    }
  }

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
      signals.lastAssistantMessageId = fallbackMessageId;
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

  const harvestedCitations: Citation[] =
    !cancelled && signals.lastAssistantText ? harvestCitations(events) : [];
  let citations: Citation[] = harvestedCitations;
  if (harvestedCitations.length > 0) {
    try {
      citations = await keepResolvableCitations(harvestedCitations, p.tenant_id, p.db);
    } catch {}
  }

  if (citations.length > 0) {
    events.push({
      type: "citations",
      citations,
      ...(signals.lastAssistantMessageId
        ? { parent_message_id: signals.lastAssistantMessageId }
        : {}),
    });
  }

  let criticVerdict: CriticVerdict | undefined;
  if (!cancelled && (signals.committed || signals.lastAssistantText)) {
    const activeKind = draft.summary?.active_target.kind;
    const resourceKind: "connector" | "workflow" | null =
      activeKind === "connector" || activeKind === "workflow" ? activeKind : null;

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

    const connectorAuthMode =
      resourceKind === "connector" ? (draft.connector?.auth_type ?? null) : null;

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
    } else {
      try {
        criticVerdict = await runCritic({
          artifact,
          snapshot: prompt.system,
          ...(resolvedEngineUrl || p.runtime_context?.tenant_slug
            ? {
                runtimeContext: {
                  ...(resolvedEngineUrl ? { engine_url: resolvedEngineUrl } : {}),
                  ...(p.runtime_context?.tenant_slug
                    ? { tenant_slug: p.runtime_context.tenant_slug }
                    : {}),
                },
              }
            : {}),
        });
        if (criticVerdict.verdict === "fail") {
          stepRouterSignals.priorCriticFail = true;
        }

        let faithfulVerdict: Awaited<ReturnType<typeof checkSourceFaithful>> | undefined;
        if (artifact.kind === "chat" && harvestedCitations.length > 0) {
          try {
            faithfulVerdict = await checkSourceFaithful({
              text: artifact.payload,
              citations: harvestedCitations,
              tenant_id: p.tenant_id,
              db: p.db,
              ...(turnAbortCtrl.signal ? { signal: turnAbortCtrl.signal } : {}),
            });
            if (faithfulVerdict.verdict === "fail") {
              stepRouterSignals.priorCriticFail = true;
            }
            logger.info({
              module: "llm",
              action: "source_faithful.verdict",
              msg: `source_faithful verdict: ${faithfulVerdict.verdict}`,
              conversation_id: p.conversation_id,
              tenant_id: p.tenant_id,
              verdict: faithfulVerdict.verdict,
              confidence: faithfulVerdict.confidence,
              reason: faithfulVerdict.reason,
              citation_count: harvestedCitations.length,
              checks: faithfulVerdict.checks,
              detail: faithfulVerdict.detail ?? null,
            });
          } catch (err) {
            logger.warn({
              module: "llm",
              action: "source_faithful.threw",
              conversation_id: p.conversation_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const failedChecks = criticVerdict.checks
          ? Object.entries(criticVerdict.checks)
              .filter(([, v]) => v === false)
              .map(([k]) => k)
          : [];
        const commitAbstains =
          criticVerdict.verdict === "fail" &&
          criticVerdict.confidence < 0.6 &&
          Boolean(signals.committed);
        const faithfulnessAbstains = faithfulVerdict?.verdict === "fail";
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
          will_escalate_next_turn: criticVerdict.verdict === "fail" || faithfulnessAbstains,
          will_abstain: commitAbstains || faithfulnessAbstains,
        });
        const abstention = abstentionDecision({
          commitAbstains,
          faithfulnessAbstains,
          hasPendingQuestion: Boolean(signals.pendingElicitation),
        });
        if (abstention === "skip_pending_question") {
          logger.info({
            module: "llm",
            action: "critic.abstention.skipped_pending_question",
            msg: "abstention not raised: the turn already ended on a pending human question",
            conversation_id: p.conversation_id,
            tenant_id: p.tenant_id,
            source: faithfulnessAbstains ? "source_faithful.abstention" : "critic.abstention",
          });
        } else if (abstention === "raise") {
          const abstain = faithfulnessAbstains
            ? {
                source: "source_faithful.abstention" as const,
                summary: `source drift: ${faithfulVerdict?.reason}`,
                question:
                  "The answer may not be faithful to the sources it cited. " +
                  `Reason: ${faithfulVerdict?.reason}. ` +
                  `${faithfulVerdict?.detail ? `Detail: ${faithfulVerdict.detail}. ` : ""}` +
                  "Confirm the answer is correct, or describe what should change.",
                confidence: faithfulVerdict?.confidence ?? 0,
                checks: Object.entries(faithfulVerdict?.checks ?? {})
                  .filter(([, v]) => v === false)
                  .map(([k]) => k),
              }
            : {
                source: "critic.abstention" as const,
                summary: `low-confidence commit: ${criticVerdict.reason}`,
                question:
                  "The critic flagged this commit with low confidence. " +
                  `Reason: ${criticVerdict.reason}. ` +
                  `${criticVerdict.hint ? `Suggested fix: ${criticVerdict.hint}. ` : ""}` +
                  "Confirm the commit, or describe what should change.",
                confidence: criticVerdict.confidence,
                checks: failedChecks,
              };
          try {
            const elicitation = await createElicitation(
              {
                tenant_id: p.tenant_id,
                conversation_id: p.conversation_id,
                tool_call_id: null,
                tool_name: "ask_user_text",
                summary: abstain.summary,
                input: {
                  question: abstain.question,
                  placeholder: "confirm | describe a fix",
                  metadata: {
                    source: abstain.source,
                    critic_kind: artifact.kind,
                    confidence: abstain.confidence,
                    failed_checks: abstain.checks,
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
              label: `${abstain.source} · ${abstain.summary}`,
            });
            logger.info({
              module: "llm",
              action: "critic.abstention.elicited",
              msg: faithfulnessAbstains
                ? "source_faithful failure produced an ask_user_text follow-up"
                : "low-confidence commit produced an ask_user_text follow-up",
              conversation_id: p.conversation_id,
              tenant_id: p.tenant_id,
              elicitation_id: elicitation.id,
              source: abstain.source,
              confidence: abstain.confidence,
              failed_checks: abstain.checks,
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
        logger.warn({
          module: "llm",
          action: "critic.threw",
          conversation_id: p.conversation_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!cancelled && signals.lastAssistantText) {
    if (citations.length > 0) {
      try {
        await auditAwait(
          {
            tenant_id: p.tenant_id,
            actor_type: p.actor_id ? "user" : "system",
            actor_id: p.actor_id,
            action: AuditAction.CONVERSATION_ANSWER_CITED,
            resource_type: "conversation",
            resource_id: p.conversation_id,
            result: "success",
            metadata: { citation_count: citations.length, citations: citations.slice(0, 20) },
          },
          p.db,
        );
      } catch (err) {
        logger.warn({
          module: "llm",
          action: "citations.audit_failed",
          msg: "could not mirror citations to audit — turn unaffected",
          conversation_id: p.conversation_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

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
    committedWorkflowId = signals.committed.workflow_id;
    const savedInertDraft = draft.state?.persisted_resources.some(
      (resource) =>
        resource.kind === "workflow" &&
        resource.id === committedWorkflowId &&
        resource.persistence_kind === "draft",
    );
    status = savedInertDraft ? "active" : "committed";
    completedStatus = status;
  } else if (signals.pendingElicitation || persistedStatus === "awaiting_input") {
    status = "awaiting_input";
    pendingElicitationId = signals.pendingElicitation?.elicitation_id;
    completedStatus = "awaiting_input";
  } else {
    completedStatus = "active";
    const unattendedTurn = p.surface === "mcp" && !p.elicitationBridge;
    const closingAsk = unattendedTurn ? closingProseQuestion(signals.lastAssistantText) : null;
    if (closingAsk) {
      try {
        const elicitation = await createElicitation(
          {
            tenant_id: p.tenant_id,
            conversation_id: p.conversation_id,
            tool_call_id: null,
            tool_name: "ask_user_text",
            summary: "the assistant asked a question",
            input: {
              question: closingAsk,
              metadata: { source: "loop.prose_question_parked" },
            },
            actor_id: p.actor_id,
          },
          p.db,
        );
        status = "awaiting_input";
        completedStatus = "awaiting_input";
        pendingElicitationId = elicitation.id;
        logger.info({
          module: "conversation",
          action: "loop.prose_question_parked",
          msg: "unattended turn ended on a prose question — parked on an ask_user_text elicitation",
          conversation_id: p.conversation_id,
          tenant_id: p.tenant_id,
          elicitation_id: elicitation.id,
        });
      } catch (err) {
        logger.warn({
          module: "conversation",
          action: "loop.prose_question_park_failed",
          msg: "could not park prose-question turn on an elicitation",
          conversation_id: p.conversation_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (status === "active" && signals.step >= budget && !signals.pendingElicitation) {
      log.warn({
        module: "conversation",
        action: "loop.budget_exhausted",
        msg: "turn stopped without done/elicitation/commit (budget reached)",
        conversation_id: p.conversation_id,
        step_budget: budget,
      });
      if (!signals.lastAssistantText) {
        try {
          const elicitation = await createElicitation(
            {
              tenant_id: p.tenant_id,
              conversation_id: p.conversation_id,
              tool_call_id: null,
              tool_name: "ask_user_text",
              summary: "step limit reached before finishing",
              input: {
                question:
                  `I stopped because I reached this turn's step limit (${budget} steps) before finishing — ` +
                  "the work kept failing when I tested it, and re-running the same approach won't help. " +
                  'Tell me how you\'d like to proceed: describe the outcome you want, or reply "diagnose" ' +
                  "to look at the last failure in detail.",
                placeholder: "describe the outcome | diagnose | change approach",
                metadata: { source: "loop.budget_exhausted", step_budget: budget },
              },
              actor_id: p.actor_id,
            },
            p.db,
          );
          status = "awaiting_input";
          completedStatus = "awaiting_input";
          pendingElicitationId = elicitation.id;
          logger.info({
            module: "conversation",
            action: "loop.budget_exhausted.elicited",
            msg: "step-budget cap parked on an ask_user_text elicitation",
            conversation_id: p.conversation_id,
            tenant_id: p.tenant_id,
            elicitation_id: elicitation.id,
            step_budget: budget,
          });
        } catch (err) {
          logger.warn({
            module: "conversation",
            action: "loop.budget_exhausted.elicit_failed",
            msg: "could not park budget-exhausted turn on an elicitation",
            conversation_id: p.conversation_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

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
        references: prompt.token_counts.references,
        total: prompt.token_counts.total,
      }
    : undefined;
  events.push({
    type: "completed",
    status: completedStatus,
    usage: {
      turn_tokens: turnTokens,
      ...(promptTokensLastCall != null ? { prompt_tokens_last_call: promptTokensLastCall } : {}),
      turn_tokens_total: turnTokensTotal,
      ...(turnInputTokens + turnCacheReadTokens > 0
        ? {
            cache_read_tokens: turnCacheReadTokens,
            cache_read_pct:
              Math.round((turnCacheReadTokens / (turnInputTokens + turnCacheReadTokens)) * 1000) /
              10,
          }
        : {}),
      remaining_monthly_budget_tokens: remaining,
      context_cap_tokens: contextCap,
      ...(breakdown ? { breakdown } : {}),
    },
  });

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
      db: p.db,
      ...(p.next_suggestion_suppress !== undefined
        ? { client_suppress: p.next_suggestion_suppress }
        : {}),
      ...(budgetGuard ? { budget_guard: budgetGuard } : {}),
    });
  }
  events.push(suggestionFrame);

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
    try {
      for (const w of weighed) {
        const skill = skills.find((s) => s.id === w.id);
        if (skill) {
          w.tokens = countSkillTokens(skill, p.runtime_context);
        }
      }
    } catch {}
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
    references_resolved: referenced.resolved.length,
    references_unresolved: referenced.unresolved.length,
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
          breakdown_references: breakdown.references,
          breakdown_total: breakdown.total,
        }
      : {}),
    ...(topSkillBreakdown ? { top_skills_by_tokens: topSkillBreakdown } : {}),
  });

  const out: RunLoopResult = { events, status };
  if (committedWorkflowId) out.committed_workflow_id = committedWorkflowId;
  if (pendingElicitationId) out.pending_elicitation_id = pendingElicitationId;
  for (const key of Object.keys(wrappedTools)) {
    delete (wrappedTools as Record<string, unknown>)[key];
  }
  return out;
}
