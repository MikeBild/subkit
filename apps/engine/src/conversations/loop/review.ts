import { AuditAction, auditAwait } from "../../audit/index.ts";
import { resolveActor } from "../../audit/recorders/types.ts";
import { type CriticVerdict, runCritic, summarizeToolResult } from "../../llm/critic/index.ts";
import { logger } from "../../logging/index.ts";
import { type Citation, harvestCitations } from "../citations.ts";
import {
  abstentionRequest,
  commitAbstains,
  elicitationActorType,
  failedChecks,
  outputGuardContext,
  type ReviewArtifact,
  reviewArtifact,
} from "../core/loop.ts";
import { checkSourceFaithful, keepResolvableCitations } from "../source-faithful.ts";
import { getTool } from "../tools/index.ts";
import { abstentionDecision } from "./abstention-gate.ts";
import { askUserText } from "./shared.ts";
import type { TurnEnv, TurnState } from "./types.ts";

type FaithfulVerdict = Awaited<ReturnType<typeof checkSourceFaithful>>;

async function collectCitations(env: TurnEnv, state: TurnState) {
  const { p, signals, events } = env;
  const harvested: Citation[] =
    !state.cancelled && signals.lastAssistantText && !state.handoffSummaryOnly
      ? harvestCitations(events)
      : [];
  let citations: Citation[] = harvested;
  if (harvested.length > 0) {
    try {
      citations = await keepResolvableCitations(harvested, p.tenant_id, p.db);
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
  return { harvested, citations };
}

async function checkFaithfulness(
  env: TurnEnv,
  text: string,
  harvested: Citation[],
): Promise<FaithfulVerdict | undefined> {
  const { p } = env;
  try {
    const verdict = await checkSourceFaithful({
      text,
      citations: harvested,
      tenant_id: p.tenant_id,
      db: p.db,
      ...(env.abort.signal ? { signal: env.abort.signal } : {}),
    });
    if (verdict.verdict === "fail") {
      env.stepRouterSignals.priorCriticFail = true;
    }
    logger.info({
      module: "llm",
      action: "source_faithful.verdict",
      msg: `source_faithful verdict: ${verdict.verdict}`,
      conversation_id: p.conversation_id,
      tenant_id: p.tenant_id,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reason: verdict.reason,
      citation_count: harvested.length,
      checks: verdict.checks,
      detail: verdict.detail ?? null,
    });
    return verdict;
  } catch (err) {
    logger.warn({
      module: "llm",
      action: "source_faithful.threw",
      conversation_id: p.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function raiseAbstention(
  env: TurnEnv,
  artifact: ReviewArtifact,
  criticVerdict: CriticVerdict,
  faithfulVerdict: FaithfulVerdict | undefined,
  criticFailedChecks: string[],
  faithfulnessAbstains: boolean,
): Promise<void> {
  const { p, signals } = env;
  const abstain = abstentionRequest({
    faithfulness: faithfulnessAbstains && faithfulVerdict ? faithfulVerdict : null,
    critic: criticVerdict,
    criticFailedChecks,
  });
  try {
    const opening = await askUserText(p, {
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
    });
    if (!opening.ok) return;
    const elicitation = opening.elicitation;
    signals.pendingChildElicitationIds.push(elicitation.id);
    env.events.push({
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

async function critique(env: TurnEnv, artifact: ReviewArtifact, harvested: Citation[]) {
  const { p, signals, events, tools } = env;
  const guardContext = outputGuardContext(env.engineUrl, p.runtime_context?.tenant_slug);
  const criticVerdict = await runCritic({
    artifact,
    snapshot: env.prompt.system,
    toolResults: events.flatMap((ev) =>
      ev.type === "tool_result" ? [summarizeToolResult(ev.tool, ev.output)] : [],
    ),
    availableTools: Object.keys(tools),
    readOnlyTools: Object.keys(tools).filter((name) => getTool(name)?.category === "tenant_read"),
    ...(Object.keys(guardContext).length > 0 ? { runtimeContext: guardContext } : {}),
  });
  if (criticVerdict.verdict === "fail") {
    env.stepRouterSignals.priorCriticFail = true;
  }
  const faithfulVerdict =
    artifact.kind === "chat" && harvested.length > 0
      ? await checkFaithfulness(env, artifact.payload, harvested)
      : undefined;
  const criticFailedChecks = criticVerdict.checks ? failedChecks(criticVerdict.checks) : [];
  const abstainsOnCommit = commitAbstains(criticVerdict, Boolean(signals.committed));
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
    failed_checks: criticFailedChecks,
    hint: criticVerdict.hint ?? null,
    will_escalate_next_turn: criticVerdict.verdict === "fail" || faithfulnessAbstains,
    will_abstain: abstainsOnCommit || faithfulnessAbstains,
  });
  const abstention = abstentionDecision({
    commitAbstains: abstainsOnCommit,
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
    await raiseAbstention(
      env,
      artifact,
      criticVerdict,
      faithfulVerdict,
      criticFailedChecks,
      faithfulnessAbstains,
    );
  }
}

async function auditCitations(env: TurnEnv, citations: Citation[]): Promise<void> {
  const { p } = env;
  try {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...resolveActor({
          tenant_id: p.tenant_id,
          actor_id: p.principal?.id ?? p.actor_id,
          actor_type: elicitationActorType(p.principal?.kind, p.actor_id),
        }),
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

export async function reviewTurnReply(env: TurnEnv, state: TurnState): Promise<void> {
  const { p, signals } = env;
  const { harvested, citations } = await collectCitations(env, state);
  if (
    !state.cancelled &&
    (signals.committed || (signals.lastAssistantText && !state.handoffSummaryOnly))
  ) {
    const artifact = reviewArtifact({
      draft: state.draft,
      committedWorkflowId: signals.committed ? signals.committed.workflow_id : null,
      assistantText: signals.lastAssistantText ?? "",
    });
    if (artifact !== null) {
      try {
        await critique(env, artifact, harvested);
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
  if (!state.cancelled && signals.lastAssistantText && citations.length > 0) {
    await auditCitations(env, citations);
  }
}
