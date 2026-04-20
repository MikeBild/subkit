// Typed LLM errors. The HTTP layer maps these to response envelopes; the
// internal flow code matches on the class.

export class LlmError extends Error {
  readonly code:
    | "llm_quota_exhausted"
    | "llm_context_too_large"
    | "llm_provider_error"
    | "llm_unavailable";
  readonly details: Record<string, unknown> | undefined;

  constructor(code: LlmError["code"], message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.details = details;
  }
}

export class LlmQuotaExhausted extends LlmError {
  constructor(
    message = "tenant monthly token budget exhausted",
    details?: Record<string, unknown>,
  ) {
    super("llm_quota_exhausted", message, details);
    this.name = "LlmQuotaExhausted";
  }
}

export class LlmContextTooLarge extends LlmError {
  constructor(
    message = "assembled prompt exceeds model context window",
    details?: Record<string, unknown>,
  ) {
    super("llm_context_too_large", message, details);
    this.name = "LlmContextTooLarge";
  }
}

export class LlmProviderError extends LlmError {
  readonly kind: "rate_limit" | "overloaded" | "context_length_exceeded" | "other";
  constructor(kind: LlmProviderError["kind"], message: string, details?: Record<string, unknown>) {
    super("llm_provider_error", message, details);
    this.name = "LlmProviderError";
    this.kind = kind;
  }
}

/**
 * Raised by the output guard when an assistant turn contains a
 * grounding violation (placeholder host, invented CLI flag, phantom
 * tool reference, etc.) AND `LLM_OUTPUT_GUARD=hard`. In `soft` mode
 * the same conditions log a metric + rewrite the text but do not
 * throw. The thrown error carries the full violation list so the
 * caller (test harness, scenario runner) can assert on individual
 * scanner kinds.
 */
export class LlmOutputViolation extends Error {
  readonly violations: ReadonlyArray<{
    /** Scanner that produced the violation, e.g. `placeholder.host`, `url.unknown_origin`. */
    kind: string;
    /** Human-readable explanation rendered into operator dashboards. */
    message: string;
    /** Span (`[start, end)`) within the scanned text that triggered the rule. */
    span?: { start: number; end: number };
    /** Free-form payload — names of placeholders matched, suggested replacements, etc. */
    details?: Record<string, unknown>;
  }>;
  constructor(violations: LlmOutputViolation["violations"]) {
    const summary = violations.map((v) => v.kind).join(", ");
    super(`llm output guard rejected ${violations.length} violation(s): ${summary}`);
    this.name = "LlmOutputViolation";
    this.violations = violations;
  }
}
