import { UNTRUSTED_CONTENT_NOTE } from "@shared/untrusted-content.ts";
import {
  isBusinessDecisionTool,
  pendingPermittedRemedy,
} from "../../llm/runtime/permitted-remedy.ts";
import { logger } from "../../logging/index.ts";
import { DEVICE_TOOL_NAMES } from "../core/device-tools/catalog.ts";
import { hasBoundSavedWorkflowTarget } from "../core/loop.ts";
import { turnExecutionSuppression } from "../execution-suppression.ts";
import {
  detectsAuthoringRequest,
  inferStateDrivenFollowUpTool,
  resolvePreferredTool,
} from "../intent-detector.ts";
import {
  applyExecutionToolGate,
  authoringSkillsForTurn,
  authoringStageOpen,
  collectSyntheticWorkflowSlugs,
  type ExecutionToolGateDecision,
  resolveExecutionToolGate,
  resolveNamedWorkflowSlug,
} from "../tools/authoring-palette.ts";
import { getTool } from "../tools/index.ts";
import {
  intakeReviewInProgress,
  intakeReviewNote,
  intakeSelectionStatus,
  removeIntakeReviewTools,
} from "../tools/sdk-wrap/intake-review-guard.ts";
import { type TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import { detectConnectorAuthoringIntent } from "./authoring-intent.ts";
import { appendVolatileSystemContext } from "./shared.ts";
import type {
  AssembledPrompt,
  RecentToolCall,
  TurnBase,
  TurnPalette,
  TurnSkills,
  TurnState,
  WrappedTools,
} from "./types.ts";

function freshSignals(): TurnSignals {
  return {
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
}

async function gateExecutionTools(
  base: TurnBase,
  state: TurnState,
  tools: WrappedTools,
): Promise<ExecutionToolGateDecision> {
  const { p, ingestedUserMessage, detectedIntent, ctx } = base;
  const syntheticWorkflowSlugs = collectSyntheticWorkflowSlugs(Object.keys(tools));
  const namedWorkflowSlug = resolveNamedWorkflowSlug(ingestedUserMessage, syntheticWorkflowSlugs);
  const executionSuppression = await turnExecutionSuppression({
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    recent_user_message: ingestedUserMessage,
  });
  const executionGate = resolveExecutionToolGate({
    hasBoundSavedWorkflow: hasBoundSavedWorkflowTarget(base.workflowIdForTurn, state.draft),
    explicitlyNamedWorkflowSlug: namedWorkflowSlug,
    explicitExternalAction:
      detectedIntent.requestExternalAction === true || detectedIntent.requestExternalRead === true,
    authoringInProgress:
      detectsAuthoringRequest(ingestedUserMessage) ||
      detectConnectorAuthoringIntent(ingestedUserMessage) ||
      authoringStageOpen(state.draft.summary?.stage),
    ...(p.surface ? { surface: p.surface } : {}),
    suppressExecution: executionSuppression.all,
    suppressLiveExecution: executionSuppression.live,
  });
  const readTool = detectedIntent.requestExternalRead === true ? tools.run_workflow : undefined;
  const removedExecutionTools = applyExecutionToolGate(
    tools,
    executionGate,
    syntheticWorkflowSlugs,
  );
  if (readTool && detectedIntent.requestExternalRead === true) tools.run_workflow = readTool;
  ctx.availableToolNames = new Set(Object.keys(tools));
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
  return executionGate;
}

function resumePermittedRemedy(
  base: TurnBase,
  tools: WrappedTools,
  recentToolCalls: RecentToolCall[],
): void {
  const { p } = base;
  const answeredCall = recentToolCalls[0];
  if (p.user_message !== null || !answeredCall || !isBusinessDecisionTool(answeredCall.tool)) {
    return;
  }
  const resumedRemedy = pendingPermittedRemedy(
    [...recentToolCalls].reverse().map((call) => ({ tool: call.tool, output: call.output })),
    new Set(Object.keys(tools)),
    { questionAnswers: false, readOnly: (name) => getTool(name)?.category === "tenant_read" },
  );
  if (resumedRemedy.length === 0) return;
  base.stepRouterSignals.pendingPermittedRemedy = resumedRemedy;
  logger.info({
    module: "conversation",
    action: "loop.resume.permitted_remedy",
    msg: "resume turn continues with the permitted step a refused call named",
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    remedy_tools: resumedRemedy,
  });
}

function steerToolChoice(base: TurnBase, state: TurnState, tools: WrappedTools) {
  const { p, ingestedUserMessage, detectedIntent } = base;
  const stateDrivenTool = inferStateDrivenFollowUpTool({
    latestUserText: ingestedUserMessage,
    ask_before_writing: p.ask_before_writing === true,
    summary: state.draft.summary,
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
  return { preferredTool, forceNoTools };
}

export async function resolveTurnPalette(
  base: TurnBase,
  state: TurnState,
  skills: TurnSkills,
  prompt: AssembledPrompt,
  activeConnectorId: string | null,
  recentToolCalls: RecentToolCall[],
): Promise<TurnPalette> {
  const { p, ctx, events, ingestedUserMessage, workflowIdForTurn } = base;
  const loadedSkills = [
    ...new Set([
      ...skills.loadedSlugMembership,
      ...authoringSkillsForTurn({
        surface: p.surface,
        draft: state.draft,
        userMessage: ingestedUserMessage,
        startNewWorkflow: base.detectedIntent.startNewWorkflow === true,
        boundConnector: activeConnectorId !== null,
        boundWorkflow: workflowIdForTurn !== null,
      }),
    ]),
  ];
  logger.debug({
    module: "conversation_palette",
    action: "palette.resolved",
    msg: "resolved authoring palette",
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    loaded_skills: loadedSkills,
    persisted_skills_count: skills.loadedSlugMembership.length,
  });

  const signals = freshSignals();
  const tools = await wrapTools(
    ctx,
    signals,
    events,
    p.db,
    loadedSkills,
    base.toolPolicies,
    p.principal ?? null,
  );
  logger.debug({
    module: "conversation_palette",
    action: "palette.tools_resolved",
    msg: "wrapped tool count",
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    loaded_skills: loadedSkills,
    tools_count: Object.keys(tools).length,
  });

  if (Object.keys(tools).some((name) => DEVICE_TOOL_NAMES.has(name)))
    appendVolatileSystemContext(prompt, UNTRUSTED_CONTENT_NOTE);

  state.paletteSkills = loadedSkills;
  state.paletteIntakeItems = intakeReviewInProgress(state.draft);

  if (intakeReviewInProgress(state.draft)) {
    removeIntakeReviewTools(tools, state.draft);
    ctx.availableToolNames = new Set(Object.keys(tools));
    const context = intakeReviewNote(
      await intakeSelectionStatus(p.db, p.tenant_id, state.draft),
      ingestedUserMessage,
      p.locale,
    );
    appendVolatileSystemContext(prompt, context);
  }

  const executionGate = await gateExecutionTools(base, state, tools);
  resumePermittedRemedy(base, tools, recentToolCalls);
  return { signals, tools, executionGate, ...steerToolChoice(base, state, tools) };
}
