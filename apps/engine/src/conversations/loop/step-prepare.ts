import type { LanguageModel, ModelMessage, StepResult, ToolSet } from "ai";
import { and, eq } from "drizzle-orm";
import { conversations } from "../../db/schema/index.ts";
import { prepareStep as routerPrepareStep, withStepNudge } from "../../llm/runtime/step-router.ts";
import { logger } from "../../logging/index.ts";
import { readMemoryUsage, timePhaseAsync } from "../../observability/runtime-telemetry.ts";
import { hasPersistedWorkflow, toMegabytes } from "../core/loop.ts";
import { elideWithinTurnToolOutputs } from "../tool-output-elision.ts";
import {
  applyExecutionToolGate,
  collectSyntheticWorkflowSlugs,
} from "../tools/authoring-palette.ts";
import {
  intakeReviewInProgress,
  removeIntakeReviewTools,
} from "../tools/sdk-wrap/intake-review-guard.ts";
import { wrapTools } from "../tools/sdk-wrap.ts";
import { assertConversationTurn } from "../turns.ts";
import { resolveLanguageModel } from "./model-resolver.ts";
import { parseLoadedSkills } from "./skill-recency.ts";
import type { Attempt, TurnEnv, TurnState } from "./types.ts";

export interface StepPreparation {
  stepNumber: number;
  steps: ReadonlyArray<StepResult<ToolSet>>;
  messages: ModelMessage[];
  model: LanguageModel;
}

async function refreshPalette(env: TurnEnv, state: TurnState, attempt: Attempt): Promise<void> {
  const { p, ctx } = env;
  const [skillRow] = await p.db
    .select({ loaded_skills: conversations.loaded_skills })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  const nextSkills = [
    ...new Set([
      ...state.paletteSkills,
      ...parseLoadedSkills(skillRow?.loaded_skills).map((entry) => entry.slug),
    ]),
  ];
  const intakeItemsNow = intakeReviewInProgress(ctx.getDraft());
  if (
    nextSkills.length === state.paletteSkills.length &&
    intakeItemsNow === state.paletteIntakeItems
  )
    return;
  state.paletteIntakeItems = intakeItemsNow;
  const refreshed = await wrapTools(
    ctx,
    env.signals,
    env.events,
    p.db,
    nextSkills,
    env.toolPolicies,
    p.principal ?? null,
  );
  if (removeIntakeReviewTools(refreshed, ctx.getDraft()).length > 0)
    ctx.availableToolNames = new Set(Object.keys(refreshed));
  applyExecutionToolGate(
    refreshed,
    env.executionGate,
    collectSyntheticWorkflowSlugs(Object.keys(refreshed)),
  );
  Object.assign(env.tools, refreshed);
  Object.assign(attempt.turnTools, refreshed);
  state.paletteSkills = nextSkills;
}

async function swapStepModel(
  env: TurnEnv,
  attempt: Attempt,
  stepNumber: number,
  targetModel: string,
  reason: string | null,
): Promise<LanguageModel | undefined> {
  const { p, stepRouterSignals } = env;
  const { modelId } = attempt;
  try {
    const model = await resolveLanguageModel(attempt.provider, targetModel, p.tenant_id, p.db);
    attempt.activeStepModel = targetModel;
    logger.info({
      module: "llm",
      action: "step_router.model_swapped",
      msg: "per-step model upgraded",
      conversation_id: p.conversation_id,
      tenant_id: p.tenant_id,
      step_number: stepNumber,
      from_model: modelId,
      to_model: targetModel,
      stage: stepRouterSignals.stage ?? "idle",
      had_repair: stepRouterSignals.hadRepairThisTurn === true,
      prior_critic_fail: stepRouterSignals.priorCriticFail === true,
      strong_run_intent: stepRouterSignals.strongRunIntent === true,
      reason,
      ...(stepRouterSignals.repairAttribution
        ? {
            repair_tool: stepRouterSignals.repairAttribution.tool,
            ...(stepRouterSignals.repairAttribution.error_kind
              ? { repair_error_kind: stepRouterSignals.repairAttribution.error_kind }
              : {}),
          }
        : {}),
    });
    return model;
  } catch (err) {
    logger.warn({
      module: "llm",
      action: "step_router.resolve_failed",
      msg: "could not resolve upgraded model — sticking with tenant default",
      conversation_id: p.conversation_id,
      tenant_id: p.tenant_id,
      provider: attempt.provider,
      target: targetModel,
      fallback_model: modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export function prepareAttemptStep(
  env: TurnEnv,
  state: TurnState,
  attempt: Attempt,
  step: StepPreparation,
) {
  return timePhaseAsync("converse.prepare_step", async () => {
    const { p, stepRouterSignals } = env;
    const { stepNumber } = step;
    const { modelId } = attempt;
    await assertConversationTurn(env.abort.signal);
    if (stepNumber > 0) await refreshPalette(env, state, attempt);
    attempt.activeStepModel = modelId;
    const m = readMemoryUsage();
    logger.info({
      module: "process",
      action: "step.memory",
      at: "prepare",
      step_number: stepNumber,
      external_mb: toMegabytes(m.external),
      rss_mb: toMegabytes(m.rss),
    });
    const elision = elideWithinTurnToolOutputs(step.messages, {
      baseline_index: attempt.baselineIndex,
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
    const routedMessages = elision ? elision.messages : step.messages;
    const liveStage = state.draft.summary?.stage;
    if (liveStage !== undefined) stepRouterSignals.stage = liveStage;
    stepRouterSignals.hasPersistedWorkflow = hasPersistedWorkflow(
      env.workflowIdForTurn,
      env.executionGate.exposeExecution,
      state.draft,
    );
    const decision = routerPrepareStep({
      stepNumber,
      steps: step.steps,
      messages: routedMessages,
      model: step.model,
      tenantDefaultModelId: modelId,
      provider: attempt.provider,
      toolsByName: attempt.toolsByName,
      paletteToolNames: Object.keys(env.tools),
      signals: stepRouterSignals,
      turnThinkingEnabled: attempt.thinkingThisTurn,
      forcedTool: env.preferredTool,
    });
    if (!decision) return elision ? { messages: elision.messages } : {};
    const result: Record<string, unknown> = elision ? { messages: elision.messages } : {};
    if (decision.modelId && decision.modelId !== modelId) {
      const swapped = await swapStepModel(
        env,
        attempt,
        stepNumber,
        decision.modelId,
        decision.reason ?? null,
      );
      if (swapped !== undefined) result.model = swapped;
    }
    const nudged = withStepNudge(attempt.systemMessages, decision.system);
    if (nudged) result.instructions = nudged;
    if (!env.forceNoTools && decision.toolChoice !== undefined)
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
        full_tool_count: Object.keys(attempt.toolsByName).length,
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
  });
}
