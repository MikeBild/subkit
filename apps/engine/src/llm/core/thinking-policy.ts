import { getConfig } from "../../config/loader.ts";

export interface ResolveThinkingInput {
  enableThinking: boolean;
  forcesTool: boolean;
}

export interface ResolveThinkingDecision {
  enabled: boolean;
  suppressedByForcedTool: boolean;
}

export function resolveThinking(input: ResolveThinkingInput): ResolveThinkingDecision {
  const enabled = input.enableThinking && !input.forcesTool;
  return {
    enabled,
    suppressedByForcedTool: input.enableThinking && input.forcesTool,
  };
}

export function readReasoningEffortSetting(tenantId?: string): ReasoningEffortSetting {
  try {
    return getConfig(tenantId).llm.reasoning_effort;
  } catch {
    return "default";
  }
}

export const REASONING_EFFORT_SETTINGS = ["default", "none", "low", "medium", "high"] as const;
export type ReasoningEffortSetting = (typeof REASONING_EFFORT_SETTINGS)[number];
export type ReasoningEffort = Exclude<ReasoningEffortSetting, "default">;

export interface ResolveTurnReasoningInput {
  setting: ReasoningEffortSetting;
  lateStage: boolean;
  supportsThinking: boolean;
  supportsReasoningEffort: boolean;
  forcesTool: boolean;
}

export interface TurnReasoningDecision extends ResolveThinkingDecision {
  effort: ReasoningEffort;
  source: "stage_default" | "setting";
}

export function resolveTurnReasoning(input: ResolveTurnReasoningInput): TurnReasoningDecision {
  if (input.setting === "default") {
    const decision = resolveThinking({
      enableThinking: input.lateStage && input.supportsThinking,
      forcesTool: input.forcesTool,
    });
    return { ...decision, effort: decision.enabled ? "high" : "none", source: "stage_default" };
  }
  if (input.setting === "none") {
    return { enabled: false, suppressedByForcedTool: false, effort: "none", source: "setting" };
  }
  const decision = resolveThinking({
    enableThinking: input.supportsThinking || input.supportsReasoningEffort,
    forcesTool: input.supportsThinking && input.forcesTool,
  });
  return { ...decision, effort: decision.enabled ? input.setting : "none", source: "setting" };
}
