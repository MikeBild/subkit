import { cacheReadReported } from "../../llm/index.ts";

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheReported: boolean;
}

type StepTokens = Omit<StepUsage, "cacheReported">;

interface RawStep {
  usage: {
    raw?: unknown;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    inputTokenDetails?: {
      cacheReadTokens?: number | undefined;
      cacheWriteTokens?: number | undefined;
    };
  };
  providerMetadata?: Record<string, unknown> | undefined;
}

export function stepPromptTokens(u: StepTokens): number {
  return Math.max(u.inputTokens, u.cacheReadTokens + u.cacheCreationTokens);
}

export function stepTotalTokens(u: StepTokens): number {
  return stepPromptTokens(u) + u.outputTokens;
}

export function readStepUsage(step: RawStep): StepUsage {
  const inputTokens = step.usage.inputTokens ?? 0;
  const outputTokens = step.usage.outputTokens ?? 0;
  let cacheReadTokens = step.usage.inputTokenDetails?.cacheReadTokens ?? 0;
  let cacheCreationTokens = step.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const anthropic = step.providerMetadata?.anthropic as
    | { usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
    | undefined;
  if (!cacheReadTokens && anthropic?.usage?.cache_read_input_tokens) {
    cacheReadTokens = Number(anthropic.usage.cache_read_input_tokens);
  }
  if (!cacheCreationTokens && anthropic?.usage?.cache_creation_input_tokens) {
    cacheCreationTokens = Number(anthropic.usage.cache_creation_input_tokens);
  }
  const cacheReported =
    cacheReadReported(step.usage) || anthropic?.usage?.cache_read_input_tokens != null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cacheReported };
}

const ABORT_TOKEN_RE = /\b(?:abort(?:ed)?|cancel(?:l?ed)?)\b/i;

export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  if (err instanceof Error) return ABORT_TOKEN_RE.test(err.message);
  return ABORT_TOKEN_RE.test(String(err));
}
