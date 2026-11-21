import { engineClientActorType } from "../../llm/accounting/index.ts";
import { log, logger } from "../../logging/index.ts";
import { recordToolHallucinatedAbsence } from "../../observability/instrumentation.ts";
import { handoffSummary, inferReplyLocale, turnHandoff } from "../handoff-summary.ts";
import { updateMessageContent } from "../persistence/index.ts";
import { settlePlaybookAtTurnEnd } from "../playbook.ts";
import { classifyFallbackSynthesis, completionEvidenceGuard } from "../turn-helpers.ts";
import { appendSyntheticAssistant } from "./shared.ts";
import { isAutomationReviewCard } from "./stop-conditions.ts";
import { detectToolHallucinatedAbsence } from "./tool-not-available-guard.ts";
import type { TurnEnv, TurnState } from "./types.ts";

async function synthesizeEmptyTurn(
  env: TurnEnv,
  completionEvidence: string | null | undefined,
): Promise<void> {
  const { p, signals, events } = env;
  if (
    signals.lastAssistantText ||
    signals.pendingElicitation ||
    signals.committed ||
    env.abort.signal.aborted
  ) {
    return;
  }
  const classified = completionEvidence
    ? { text: completionEvidence, reason: "tool_results_summary" as const }
    : classifyFallbackSynthesis({ events, loopWarnings: signals.totalLoopWarnings });
  if (!classified) return;
  await appendSyntheticAssistant(p, events, signals, classified.text, "empty_turn_fallback");
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

async function synthesizeHandoff(env: TurnEnv, state: TurnState): Promise<void> {
  const { p, signals, events } = env;
  const lastToolResult = events.findLast((event) => event.type === "tool_result");
  const handoff = turnHandoff(
    signals.pendingElicitation,
    lastToolResult?.type === "tool_result" &&
      lastToolResult.tool === "review_workflow_automation" &&
      isAutomationReviewCard(lastToolResult.output),
  );
  if (
    !handoff ||
    state.lastStepHadText ||
    state.cancelled ||
    signals.committed ||
    env.abort.signal.aborted
  ) {
    return;
  }
  const locale = p.locale ?? inferReplyLocale(env.ingestedUserMessage);
  const closing = handoffSummary({ locale, handoff: handoff.handoff, evidence: handoff.evidence });
  state.handoffSummaryOnly = !signals.lastAssistantText;
  await appendSyntheticAssistant(p, events, signals, closing, "handoff_summary");
  log.info({
    module: "conversation",
    action: "loop.handoff_summary_synthesized",
    msg: "turn ended on a hand-off without assistant text — added a short result and next step",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    handoff: handoff.handoff,
    preview_evidence: handoff.evidence?.preview ?? null,
    locale,
  });
}

async function settlePlaybook(env: TurnEnv): Promise<void> {
  const { p } = env;
  try {
    const settledRevision = await settlePlaybookAtTurnEnd(p.db, {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      actor: { actor_type: engineClientActorType(p.principal, p.actor_id), actor_id: p.actor_id },
      request_source: p.surface === "mcp" ? "mcp" : "ui",
    });
    if (settledRevision !== null)
      log.info({
        module: "conversation",
        action: "playbook.turn_settled",
        msg: "turn ended with playbook steps still in progress — they now wait for the user",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        revision: settledRevision,
      });
  } catch (err) {
    log.warn({
      module: "conversation",
      action: "playbook.turn_settle_failed",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      error_message: err instanceof Error ? err.message : String(err),
    });
  }
}

function flagHallucinatedAbsence(env: TurnEnv): void {
  const { p, signals } = env;
  if (!signals.lastAssistantText) return;
  const verdict = detectToolHallucinatedAbsence({
    assistantText: signals.lastAssistantText,
    palette: new Set(Object.keys(env.tools)),
  });
  if (!verdict.hallucinated || !verdict.toolName) return;
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

export async function closeTurnReply(env: TurnEnv, state: TurnState): Promise<void> {
  const { p, signals, events } = env;
  const completionEvidence = completionEvidenceGuard(events, state.draft, env.ingestedUserMessage);
  if (completionEvidence && signals.lastAssistantMessageId) {
    await updateMessageContent(p.db, signals.lastAssistantMessageId, {
      text: completionEvidence,
      _synthetic: true,
      _reason: "completion_evidence_guard",
    });
    events.push({
      type: "message",
      role: "assistant",
      content: { text: completionEvidence },
      id: signals.lastAssistantMessageId,
      parent_message_id: signals.lastAssistantMessageId,
    });
    signals.lastAssistantText = completionEvidence;
  }
  await synthesizeEmptyTurn(env, completionEvidence);
  await synthesizeHandoff(env, state);
  await settlePlaybook(env);
  flagHallucinatedAbsence(env);
}
