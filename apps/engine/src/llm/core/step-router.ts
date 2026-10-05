import type { LanguageModel, ModelMessage, ToolChoice, ToolSet } from "ai";
import type { ConversationSurface } from "../../conversations/agent/types.ts";
import { REVIEW_DECISIONS } from "../../conversations/tools/authoring-palette.ts";
import type { ConversationTool } from "../../conversations/tools/index.ts";
import type { AuthoringStage } from "../../conversations/types.ts";
import { logger } from "../../logging/logger.ts";
import { vendorModelId } from "../pricing.ts";
import type { LlmProviderKind } from "../types.ts";
import { resolveThinking } from "./thinking-policy.ts";

const NO_UPGRADE_WARNED: Set<string> = new Set();

export interface StepRouterSignals {
  stage?: AuthoringStage;
  surface?: ConversationSurface;
  hasPersistedWorkflow?: boolean;
  hadRepairThisTurn?: boolean;
  repairAttribution?: { tool: string; error_kind?: string | undefined };
  strongRunIntent?: boolean;
  multiArtifactIntent?: boolean;
  priorCriticFail?: boolean;
  escalate?: boolean;
  escalateMax?: boolean;
}

export interface StepRouterParams {
  stepNumber: number;
  steps: ReadonlyArray<unknown>;
  messages: ReadonlyArray<ModelMessage>;
  model: LanguageModel;
  tenantDefaultModelId: string;
  provider: LlmProviderKind;
  toolsByName: Record<string, ConversationTool>;
  paletteToolNames?: readonly string[];
  signals: StepRouterSignals;
  turnThinkingEnabled?: boolean;
  forcedTool?: string | null;
}

export interface StepDecision {
  modelId?: string;
  toolChoice?: ToolChoice<ToolSet>;
  activeTools?: string[];
  system?: string;
  reason?: string;
}

interface UpgradeLadder {
  oneUp: Record<string, string>;
  top: Record<string, string>;
}

const ANTHROPIC_LADDER: UpgradeLadder = {
  oneUp: {
    "claude-3-5-haiku": "claude-3-5-sonnet",
    "claude-3-5-sonnet": "claude-3-opus",
    "claude-3-opus": "claude-opus-4-7",
    "claude-haiku-4-5": "claude-sonnet-4-6",
    "claude-sonnet-4-5": "claude-opus-4-7",
    "claude-sonnet-4-6": "claude-opus-4-7",
    "claude-opus-4-6": "claude-opus-4-7",
    "claude-opus-4-7": "claude-opus-4-8",
  },
  top: {
    "claude-3-5-haiku": "claude-opus-4-8",
    "claude-3-5-sonnet": "claude-opus-4-8",
    "claude-3-opus": "claude-opus-4-8",
    "claude-haiku-4-5": "claude-opus-4-8",
    "claude-sonnet-4-5": "claude-opus-4-8",
    "claude-sonnet-4-6": "claude-opus-4-8",
    "claude-opus-4-6": "claude-opus-4-8",
    "claude-opus-4-7": "claude-opus-4-8",
  },
};

const OPENAI_LADDER: UpgradeLadder = {
  oneUp: {
    "gpt-4o-mini": "gpt-4o",
    "gpt-4o": "gpt-4.1",
    "gpt-4-turbo": "gpt-4o",
    "o1-mini": "o1-preview",
  },
  top: {
    "gpt-4o-mini": "gpt-4.1",
    "gpt-4o": "gpt-4.1",
    "gpt-4-turbo": "gpt-4.1",
    "gpt-4.1": "gpt-4.1",
    "o1-mini": "o1-preview",
    "o1-preview": "o1-preview",
  },
};

const GEMINI_LADDER: UpgradeLadder = {
  oneUp: {
    "gemini-1.5-flash": "gemini-1.5-pro",
    "gemini-2.0-flash": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-pro",
  },
  top: {
    "gemini-1.5-flash": "gemini-2.5-pro",
    "gemini-1.5-pro": "gemini-2.5-pro",
    "gemini-2.0-flash": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-pro",
    "gemini-2.5-pro": "gemini-2.5-pro",
  },
};

const LADDERS: Partial<Record<LlmProviderKind, UpgradeLadder>> = {
  anthropic: ANTHROPIC_LADDER,
  bedrock: ANTHROPIC_LADDER,
  vertex: ANTHROPIC_LADDER,
  gateway: ANTHROPIC_LADDER,
  openai: OPENAI_LADDER,
  azure: OPENAI_LADDER,
  gemini: GEMINI_LADDER,
};

export function ladderModelIds(): string[] {
  const ids = new Set<string>();
  for (const ladder of new Set(Object.values(LADDERS))) {
    if (!ladder) continue;
    for (const table of [ladder.oneUp, ladder.top]) {
      for (const [from, to] of Object.entries(table)) {
        ids.add(from);
        ids.add(to);
      }
    }
  }
  return [...ids].sort();
}

export function routeUp(provider: LlmProviderKind, modelId: string): string {
  const ladder = LADDERS[provider];
  if (!ladder) {
    warnOnceNoUpgrade(provider, modelId, "no_ladder_for_provider");
    return modelId;
  }
  const bare = vendorModelId(modelId);
  const upgraded = ladder.oneUp[bare];
  if (upgraded === undefined) {
    warnOnceNoUpgrade(provider, modelId, "no_upgrade_in_ladder");
    return modelId;
  }
  return upgraded;
}

export function routeTop(provider: LlmProviderKind, modelId: string): string {
  const ladder = LADDERS[provider];
  if (!ladder) return modelId;
  const bare = vendorModelId(modelId);
  return ladder.top[bare] ?? modelId;
}

function warnOnceNoUpgrade(provider: LlmProviderKind, modelId: string, reason: string): void {
  const key = `${provider}::${vendorModelId(modelId)}::${reason}`;
  if (NO_UPGRADE_WARNED.has(key)) return;
  NO_UPGRADE_WARNED.add(key);
  logger.warn({
    module: "llm",
    action: "step_router.no_upgrade_available",
    msg: "no upgrade tier available for this provider+model — escalation will be a no-op",
    provider,
    model: modelId,
    reason,
  });
}

export function supportsExtendedThinking(provider: LlmProviderKind, modelId: string): boolean {
  if (
    provider !== "anthropic" &&
    provider !== "bedrock" &&
    provider !== "vertex" &&
    provider !== "gateway"
  )
    return false;
  const bare = vendorModelId(modelId);
  return /^claude-(sonnet-4-5|sonnet-4-6|opus-4-6|opus-4-7|opus-4-8)/.test(bare);
}

const ALWAYS_AVAILABLE: ReadonlySet<string> = new Set([
  "ask_user_choice",
  "ask_user_multi",
  "ask_user_text",
  "ask_user_form",
  "ask_user_confirm",
  "cannot_help",
  "load_skill",
  "list_skills",
  "list_skill_suggestions",
  "search_knowledge",
  "search_docs",
  "fetch_connector_docs",
  "get_raw_result",
  "inspect_authoring_context",
]);

function activeToolsForStage(
  stage: AuthoringStage | undefined,
  toolsByName: Record<string, ConversationTool>,
  forcedTool: string | null | undefined,
  hasPersistedWorkflow: boolean,
  paletteToolNames: readonly string[] = [],
): string[] | undefined {
  const names = Object.keys(toolsByName);
  const activeAuthoringResource =
    stage?.startsWith("connector_") && stage !== "connector_persisted"
      ? "connector"
      : stage?.startsWith("workflow_") && stage !== "workflow_persisted"
        ? "workflow"
        : null;
  const dropPersistedRequired = !hasPersistedWorkflow;
  const keep = (predicate: (t: ConversationTool) => boolean): string[] => {
    const kept = names.filter((n) => {
      if (forcedTool && n === forcedTool) return true;
      if (ALWAYS_AVAILABLE.has(n)) {
        const t = toolsByName[n];
        if (dropPersistedRequired && t?.requires_persisted_workflow === true) return false;
        return true;
      }
      const t = toolsByName[n];
      if (!t) return false;
      if (t.inert_proposal === true) return true;
      if (REVIEW_DECISIONS.has(n)) return true;
      if (
        activeAuthoringResource &&
        t.authoring_resource &&
        t.authoring_resource !== activeAuthoringResource
      ) {
        return false;
      }
      if (dropPersistedRequired && t.requires_persisted_workflow === true) return false;
      if (n === "run_workflow" && hasPersistedWorkflow) return true;
      return predicate(t);
    });
    return kept;
  };

  const fullPaletteWithDrop = (): string[] | undefined => {
    if (!dropPersistedRequired) return undefined;
    return [...keep(() => true), ...paletteToolNames.filter((n) => !toolsByName[n])];
  };

  if (!stage || stage === "idle") {
    return fullPaletteWithDrop();
  }
  switch (stage) {
    case "connector_targeted":
    case "workflow_targeted":
      return keep((t) => t.category === "tenant_read");
    case "diagnosing":
      return keep(
        (t) =>
          t.category === "tenant_read" ||
          (t.category === "draft_write" && t.authoring_resource === "workflow"),
      );
    case "connector_draft_started":
    case "connector_inspected":
    case "connector_validated":
    case "connector_authenticated":
    case "connector_probed":
    case "workflow_draft_started":
    case "workflow_inspected":
    case "workflow_validated":
    case "workflow_previewed":
      return keep((t) => t.category === "tenant_read" || t.category === "draft_write");
    case "repairing":
      return fullPaletteWithDrop();
    case "connector_persisted":
      return fullPaletteWithDrop();
    case "workflow_persisted":
    case "workflow_executed":
      return undefined;
    default: {
      const _exhaustive: never = stage;
      void _exhaustive;
      return undefined;
    }
  }
}

export function prepareStep(params: StepRouterParams): StepDecision | undefined {
  const { signals, provider, tenantDefaultModelId, toolsByName } = params;

  let modelId: string | undefined;
  const reasonParts: string[] = [];

  const hardStageEscalates = isHardStage(signals.stage) && signals.surface !== "chat";

  if (signals.escalateMax === true || signals.priorCriticFail === true) {
    const top = routeTop(provider, tenantDefaultModelId);
    if (top !== tenantDefaultModelId) {
      modelId = top;
      reasonParts.push(signals.priorCriticFail ? "prior_critic_fail" : "escalate_max");
    }
  } else if (
    signals.escalate === true ||
    signals.hadRepairThisTurn === true ||
    signals.strongRunIntent === true ||
    hardStageEscalates
  ) {
    const next = routeUp(provider, tenantDefaultModelId);
    if (next !== tenantDefaultModelId) {
      modelId = next;
      if (signals.hadRepairThisTurn) reasonParts.push("repair_in_prior_step");
      if (signals.strongRunIntent) reasonParts.push("strong_run_intent");
      if (signals.escalate) reasonParts.push("escalate_signal");
      if (hardStageEscalates) reasonParts.push(`hard_stage:${signals.stage}`);
    }
  }

  const activeTools = activeToolsForStage(
    signals.stage,
    toolsByName,
    params.stepNumber === 0 ? params.forcedTool : null,
    signals.hasPersistedWorkflow === true,
    params.paletteToolNames,
  );
  if (activeTools !== undefined) {
    reasonParts.push(`narrow:${activeTools.length}`);
  }

  let toolChoice: StepDecision["toolChoice"] =
    params.forcedTool && params.stepNumber > 0 ? "auto" : undefined;
  let systemNudge: string | undefined;
  if (signals.multiArtifactIntent === true && priorStepWasSuccessfulConnectorAutoPersist(params)) {
    const thinking = resolveThinking({
      enableThinking: params.turnThinkingEnabled === true,
      forcesTool: true,
    });
    if (!thinking.suppressedByForcedTool) {
      toolChoice = "required";
    }
    systemNudge =
      "The user asked for both a connector AND a workflow in their most recent message. The connector is now saved. Continue with the workflow now — call the authoring tool author_workflow. Do NOT end the turn with a `now let's …` closing sentence; the user already approved the multi-artifact intent.";
    reasonParts.push(
      thinking.suppressedByForcedTool
        ? "multi_artifact_continue_nudge_only"
        : "multi_artifact_continue",
    );
  }

  if (
    modelId === undefined &&
    activeTools === undefined &&
    toolChoice === undefined &&
    systemNudge === undefined
  ) {
    return undefined;
  }
  const decision: StepDecision = {};
  if (modelId !== undefined) decision.modelId = modelId;
  if (activeTools !== undefined) decision.activeTools = activeTools;
  if (toolChoice !== undefined) decision.toolChoice = toolChoice;
  if (systemNudge !== undefined) decision.system = systemNudge;
  if (reasonParts.length > 0) decision.reason = reasonParts.join(",");
  return decision;
}

function priorStepWasSuccessfulConnectorAutoPersist(params: StepRouterParams): boolean {
  const prior = params.steps[params.steps.length - 1] as
    | {
        toolResults?: ReadonlyArray<{ toolName?: unknown; output?: unknown }>;
      }
    | undefined;
  const results = Array.isArray(prior?.toolResults) ? prior.toolResults : [];
  return results.some((r) => {
    if (r?.toolName !== "save_connector_draft") return false;
    const output = r.output as Record<string, unknown> | null | undefined;
    if (!output || typeof output !== "object") return false;
    return output.source === "harness_auto_persist" && output.ok === true;
  });
}

function isHardStage(stage: AuthoringStage | undefined): boolean {
  if (!stage) return false;
  switch (stage) {
    case "idle":
    case "connector_targeted":
    case "workflow_targeted":
      return false;
    default:
      return true;
  }
}
