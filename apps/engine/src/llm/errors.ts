import type { GenerationAbort, GenerationNeed } from "./runtime/generation-abort.ts";

export class LlmError extends Error {
  readonly code:
    | "llm_quota_exhausted"
    | "llm_context_too_large"
    | "llm_provider_error"
    | "llm_unavailable"
    | "ai_access_missing";
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

export class LlmAccessMissing extends LlmError {
  constructor(
    message = "This workspace has no AI access yet. Enter your provider and API key under Settings → AI assistant.",
    details?: Record<string, unknown>,
  ) {
    super("ai_access_missing", message, details);
    this.name = "LlmAccessMissing";
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

export class LlmGenerationAborted extends LlmProviderError {
  readonly reason: string;
  readonly needs: GenerationNeed[];
  constructor(abort: GenerationAbort) {
    super("other", abort.reason, { needs: abort.needs });
    this.name = "LlmGenerationAborted";
    this.reason = abort.reason;
    this.needs = abort.needs;
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
