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
  readonly kind:
    | "rate_limit"
    | "quota_exhausted"
    | "overloaded"
    | "context_length_exceeded"
    | "other";
  constructor(kind: LlmProviderError["kind"], message: string, details?: Record<string, unknown>) {
    super("llm_provider_error", message, details);
    this.name = "LlmProviderError";
    this.kind = kind;
  }
}

export class LlmOutputViolation extends Error {
  readonly violations: ReadonlyArray<{
    kind: string;
    message: string;
    span?: { start: number; end: number };
    details?: Record<string, unknown>;
  }>;
  constructor(violations: LlmOutputViolation["violations"]) {
    const summary = violations.map((v) => v.kind).join(", ");
    super(`llm output guard rejected ${violations.length} violation(s): ${summary}`);
    this.name = "LlmOutputViolation";
    this.violations = violations;
  }
}
