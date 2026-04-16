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
