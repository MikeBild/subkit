import { and, eq } from "drizzle-orm";
import { conversations } from "../../db/schema/index.ts";
import { log, logger } from "../../logging/logger.ts";
import { CONVERSATION_CANCELLED_REASON } from "../abort.ts";
import {
  budgetExhausted,
  budgetExhaustedQuestion,
  savedInertDraft,
  type TurnOutcome,
  turnOutcome,
} from "../core/loop.ts";
import { closingProseQuestion } from "../prose-question.ts";
import { askUserText } from "./shared.ts";
import type { TurnEnv, TurnState } from "./types.ts";

async function parkOnProseQuestion(env: TurnEnv, outcome: TurnOutcome): Promise<TurnOutcome> {
  const { p, signals } = env;
  const unattendedTurn = p.surface === "mcp" && !p.elicitationBridge;
  const closingAsk = unattendedTurn ? closingProseQuestion(signals.lastAssistantText) : null;
  if (!closingAsk) return outcome;
  try {
    const elicitation = await askUserText(p, {
      summary: "the assistant asked a question",
      input: { question: closingAsk, metadata: { source: "loop.prose_question_parked" } },
    });
    logger.info({
      module: "conversation",
      action: "loop.prose_question_parked",
      msg: "unattended turn ended on a prose question — parked on an ask_user_text elicitation",
      conversation_id: p.conversation_id,
      tenant_id: p.tenant_id,
      elicitation_id: elicitation.id,
    });
    return { status: "awaiting_input", pending_elicitation_id: elicitation.id, parkable: false };
  } catch (err) {
    logger.warn({
      module: "conversation",
      action: "loop.prose_question_park_failed",
      msg: "could not park prose-question turn on an elicitation",
      conversation_id: p.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return outcome;
  }
}

async function parkOnBudgetExhaustion(env: TurnEnv, outcome: TurnOutcome): Promise<TurnOutcome> {
  const { p, signals, budget } = env;
  if (
    !budgetExhausted({
      status: outcome.status,
      step: signals.step,
      budget,
      hasPendingElicitation: Boolean(signals.pendingElicitation),
    })
  ) {
    return outcome;
  }
  log.warn({
    module: "conversation",
    action: "loop.budget_exhausted",
    msg: "turn stopped without done/elicitation/commit (budget reached)",
    conversation_id: p.conversation_id,
    step_budget: budget,
  });
  if (signals.lastAssistantText) return outcome;
  try {
    const elicitation = await askUserText(p, {
      summary: "step limit reached before finishing",
      input: budgetExhaustedQuestion(budget),
    });
    logger.info({
      module: "conversation",
      action: "loop.budget_exhausted.elicited",
      msg: "step-budget cap parked on an ask_user_text elicitation",
      conversation_id: p.conversation_id,
      tenant_id: p.tenant_id,
      elicitation_id: elicitation.id,
      step_budget: budget,
    });
    return { status: "awaiting_input", pending_elicitation_id: elicitation.id, parkable: false };
  } catch (err) {
    logger.warn({
      module: "conversation",
      action: "loop.budget_exhausted.elicit_failed",
      msg: "could not park budget-exhausted turn on an elicitation",
      conversation_id: p.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return outcome;
  }
}

export async function resolveTurnOutcome(env: TurnEnv, state: TurnState): Promise<TurnOutcome> {
  const { p, signals } = env;
  const rows = await p.db
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  const committedWorkflowId = signals.committed ? signals.committed.workflow_id : null;
  const outcome = turnOutcome({
    cancelled: state.cancelled,
    persistedStatus: rows[0]?.status ?? null,
    cancelledByConversation: env.abort.signal.reason === CONVERSATION_CANCELLED_REASON,
    committedWorkflowId,
    savedInertDraft:
      committedWorkflowId !== null && savedInertDraft(state.draft, committedWorkflowId),
    pendingElicitationId: signals.pendingElicitation?.elicitation_id,
    hasPendingElicitation: Boolean(signals.pendingElicitation),
  });
  if (!outcome.parkable) return outcome;
  return parkOnBudgetExhaustion(env, await parkOnProseQuestion(env, outcome));
}
