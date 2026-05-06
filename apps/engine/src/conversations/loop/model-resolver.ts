// SDK language-model resolution. The mock provider returns a fresh
// `MockLanguageModelV3` that reads from the shared plan-cursor
// singleton; real providers go through the provider registry (A1) so
// the `anthropic:` prefix is stripped natively.

import { resolveLanguageModel as resolveSdkModel } from "../../llm/core/invoke.ts";
import { createMockLanguageModel } from "../../llm/mock-stream.ts";
import type { LlmProviderKind } from "../../llm/types.ts";

/** Per-turn step ceiling — the model gets at most this many SDK steps. */
export const DEFAULT_BUDGET = 50;

/**
 * Hard cap on `experimental_repairToolCall` invocations per turn.
 * Beyond this the model is in a degenerate state and additional repair
 * calls just burn budget — surface the failure to the loop so the next
 * turn's prepareStep can escalate.
 */
export const MAX_REPAIRS_PER_TURN = 2;

/**
 * Provider tag the loop carries through `RunLoopParams.model`. `"mock"`
 * is the in-process test provider; the rest are forwarded to the SDK
 * registry. Pinning the union here (rather than `string`) means a
 * future SDK rename cannot silently land via the previous `as any`
 * cast.
 */
export type LoopProviderKind = LlmProviderKind | "mock";

export async function resolveLanguageModel(provider: LoopProviderKind, modelId: string) {
  if (provider === "mock") return createMockLanguageModel(modelId);
  return await resolveSdkModel(provider, modelId);
}
