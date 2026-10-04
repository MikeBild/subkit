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
