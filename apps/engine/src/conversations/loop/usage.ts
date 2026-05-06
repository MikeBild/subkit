// Per-step token-usage normalisation. The SDK exposes usage through
// `step.usage` plus an Anthropic-specific `providerMetadata.anthropic.usage`
// fallback when the unified usage fields are unset. Pulling this out of
// the loop body keeps the orchestrator focused on control flow and lets
// us unit-test the cache-token reconciliation logic.

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface RawStep {
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    inputTokenDetails?: {
      cacheReadTokens?: number | undefined;
      cacheWriteTokens?: number | undefined;
    };
  };
  providerMetadata?: Record<string, unknown> | undefined;
}

export function readStepUsage(step: RawStep): StepUsage {
  const inputTokens = step.usage.inputTokens ?? 0;
  const outputTokens = step.usage.outputTokens ?? 0;
  let cacheReadTokens = step.usage.inputTokenDetails?.cacheReadTokens ?? 0;
  let cacheCreationTokens = step.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  // Anthropic surfaces cache tokens via providerMetadata.anthropic.usage
  // when the unified usage fields are unset. Prefer the flat fields and
  // fall back to provider metadata.
  const anthropic = step.providerMetadata?.anthropic as
    | { usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
    | undefined;
  if (!cacheReadTokens && anthropic?.usage?.cache_read_input_tokens) {
    cacheReadTokens = Number(anthropic.usage.cache_read_input_tokens);
  }
  if (!cacheCreationTokens && anthropic?.usage?.cache_creation_input_tokens) {
    cacheCreationTokens = Number(anthropic.usage.cache_creation_input_tokens);
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

// Heuristic abort/cancel detection.
//
// The first arm (DOMException AbortError/TimeoutError) is the
// canonical signal — every modern fetch / stream / setTimeout
// abort lands here. The remaining arms are best-effort matches
// against SDK shapes that throw a regular Error or a string.
// The regex is anchored on word boundaries so a substring like
// "cancellation policy" inside a provider message DOES NOT count
// as user abort — that was a documented false-positive class on
// the prior loose regex; collapsing a real provider error into
// "abort" makes the loop swallow it instead of surfacing it.
// Pinned by the unit tests below.
const ABORT_TOKEN_RE = /\b(?:abort(?:ed)?|cancel(?:l?ed)?)\b/i;

export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  if (err instanceof Error) return ABORT_TOKEN_RE.test(err.message);
  return ABORT_TOKEN_RE.test(String(err));
}
