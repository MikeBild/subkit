// Anthropic API constraint: `thinking: { type: "adaptive" }` cannot be
// combined with `tool_choice: { type: "tool" }` or
// `tool_choice: "any"` / `"required"`. The constraint applies at the
// streamText boundary (providerOptions are global per invocation), so
// both call-sites that decide whether to enable thinking AND whether
// to force a tool must agree. This helper is the single source of
// truth for that decision.
//
// Observed without this gate: 3× `converse.failed` warnings in session
// 0498925e on `claude-sonnet-4-5` ("Thinking may not be enabled when
// tool_choice forces tool use").

export interface ResolveThinkingInput {
  /** True when the turn is on a hard stage AND the model supports thinking. */
  enableThinking: boolean;
  /**
   * True when the turn forces a specific tool — either at the call-site
   * (`preferredTool` set on the loop) or because the step-router will
   * flip `toolChoice` to `"required"` (e.g. multi-artifact continuation).
   */
  forcesTool: boolean;
}

export interface ResolveThinkingDecision {
  /** Final flag: enable thinking on this turn. */
  enabled: boolean;
  /**
   * True when thinking WOULD have been enabled but was suppressed
   * because the turn forces a tool. Telemetry / log surface.
   */
  suppressedByForcedTool: boolean;
}

/**
 * Decide whether to enable Anthropic extended thinking for this turn.
 * Suppresses thinking whenever the turn forces a tool, because the
 * provider rejects the combination.
 */
export function resolveThinking(input: ResolveThinkingInput): ResolveThinkingDecision {
  const enabled = input.enableThinking && !input.forcesTool;
  return {
    enabled,
    suppressedByForcedTool: input.enableThinking && input.forcesTool,
  };
}
