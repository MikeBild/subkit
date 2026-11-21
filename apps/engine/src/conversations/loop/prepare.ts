import { and, eq, sql } from "drizzle-orm";
import { conversations } from "../../db/schema/index.ts";
import { engineClientActorType, monthlyUsage } from "../../llm/accounting/index.ts";
import { resolveModelRoute } from "../../llm/runtime/invoke.ts";
import type { StepRouterSignals } from "../../llm/runtime/step-router.ts";
import { engineUrlFromConfig } from "../../llm/runtime-context.ts";
import { log, logger } from "../../logging/index.ts";
import { now } from "../../utils/clock.ts";
import { resolveAttachmentSlugsInText } from "../attachments.ts";
import { hasInProgressWorkflowDraft, startNewWorkflowDraft } from "../authoring-state/index.ts";
import { getTaskRunMarker } from "../core/draft.ts";
import { hasBoundSavedWorkflow } from "../core/loop.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { EventSink } from "../event-sink.ts";
import {
  detectMultiArtifactIntent,
  detectUserIntent,
  matchesEnumerationIntent,
  NO_SNAPSHOT_COVERAGE,
} from "../intent-detector.ts";
import { appendMessage } from "../persistence/index.ts";
import { markLatestUserMessageUnresolvedReferences, resolveReferences } from "../references.ts";
import { withTaskRunMarker } from "../service/task-run-marker.ts";
import type { ToolContext } from "../tools/index.ts";
import { assertConversationTurn } from "../turns.ts";
import type { TurnEvent } from "../types.ts";
import { loadEnumerationCoverage } from "./enumeration-coverage.ts";
import { parseLoadedSkills } from "./skill-recency.ts";
import { conversationSpendBefore } from "./spend-notice.ts";
import type { RunLoopParams, ToolPolicies, TurnBase, TurnState } from "./types.ts";

async function ingestUserMessage(p: RunLoopParams, events: TurnEvent[]): Promise<string | null> {
  if (!p.user_message) return p.user_message;
  const rewrite = await resolveAttachmentSlugsInText(p.user_message, {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    ...(p.principal !== undefined ? { principal: p.principal } : {}),
  });
  const ingested = rewrite.text;
  if (!p.user_message_persisted) {
    await appendMessage(p.db, p.tenant_id, p.conversation_id, "user", {
      text: ingested,
      ...(p.user_references && p.user_references.length > 0
        ? { references: p.user_references }
        : {}),
    });
  }
  events.push({ type: "message", role: "user", content: { text: ingested } });
  return ingested;
}

export async function openTurn(
  p: RunLoopParams,
  budget: number,
): Promise<{ base: TurnBase; state: TurnState }> {
  const sink = new EventSink(p.onEvent);
  const events: TurnEvent[] = sink.asArrayProxy();
  const engineUrl = p.runtime_context?.engine_url ?? engineUrlFromConfig();
  const abort = p.turn_abort_ctrl;

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
  const spendBefore = await conversationSpendBefore(p);
  const ingestedUserMessage = await ingestUserMessage(p, events);

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
  const openingDraft = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  const taskRun = getTaskRunMarker(openingDraft);

  const state: TurnState = {
    draft: openingDraft,
    promptTokensLastCall: null,
    turnTokensTotal: 0,
    turnInputTokens: 0,
    turnCacheReadTokens: 0,
    lastStepHadText: false,
    handoffSummaryOnly: false,
    paletteSkills: [],
    paletteIntakeItems: false,
    cancelled: false,
  };
  if (
    !taskRun &&
    detectedIntent.startNewWorkflow === true &&
    hasBoundSavedWorkflow(workflowIdForTurn, state.draft) &&
    !hasInProgressWorkflowDraft(state.draft)
  ) {
    state.draft = startNewWorkflowDraft(state.draft);
    workflowIdForTurn = null;
    await p.db
      .update(conversations)
      .set({ target_workflow_id: null, updated_at: new Date(now()) })
      .where(
        and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)),
      );
    await appendSnapshot(p.tenant_id, p.conversation_id, state.draft, p.db);
  }
  const { EngineClient } = await import("../../engine-client/index.ts");
  const ctx: ToolContext = {
    ...(p.locale ? { locale: p.locale } : {}),
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    principal: p.principal ?? null,
    task_run: taskRun,
    connector_id: p.connector_id,
    workflow_id: workflowIdForTurn,
    ask_before_writing: p.ask_before_writing === true,
    ...(p.surface ? { surface: p.surface } : {}),
    engineClient: new EngineClient({
      tenant_id: p.tenant_id,
      actor_id: p.actor_id,
      actor_type: engineClientActorType(p.principal, p.actor_id),
      db: p.db,
    }),
    getDraft: () => state.draft,
    setDraft: async (next) => {
      await assertConversationTurn(abort.signal);
      state.draft = withTaskRunMarker(next, taskRun);
      await appendSnapshot(p.tenant_id, p.conversation_id, state.draft, p.db);
    },
    abortSignal: abort.signal,
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
      playbook_mode: conversations.playbook_mode,
      target_connector_id: conversations.target_connector_id,
    })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  ctx.playbook_mode = convRow[0]?.playbook_mode === "off" ? "off" : "auto";
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

  return {
    state,
    base: {
      p,
      events,
      budget,
      engineUrl,
      abort,
      usageBefore,
      spendBefore,
      ingestedUserMessage,
      currentUserText,
      referenced,
      detectedIntent,
      workflowIdForTurn,
      ctx,
      route,
      seedModel,
      stepRouterSignals,
      currentTurn: turnRow?.turn_count ?? 1,
      loadedEntries,
      toolPolicies: (convRow[0]?.tool_policies ?? {}) as ToolPolicies,
      targetConnectorId: convRow[0]?.target_connector_id ?? null,
    },
  };
}
