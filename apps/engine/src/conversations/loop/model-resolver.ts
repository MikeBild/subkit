// SDK language-model resolution. The mock provider returns a fresh
// `MockLanguageModelV3` that reads from the shared plan-cursor
// singleton; real providers go through the provider registry (A1) so
// the `anthropic:` prefix is stripped natively.

import { resolveLanguageModel as resolveSdkModel } from "../../llm/core/invoke.ts";
import { createMockLanguageModel } from "../../llm/mock-stream.ts";

/** Per-turn step ceiling — the model gets at most this many SDK steps. */
export const DEFAULT_BUDGET = 50;

/**
 * Hard cap on `experimental_repairToolCall` invocations per turn.
 * Beyond this the model is in a degenerate state and additional repair
 * calls just burn budget — surface the failure to the loop so the next
 * turn's prepareStep can escalate.
 */
export const MAX_REPAIRS_PER_TURN = 2;

export async function resolveLanguageModel(provider: string, modelId: string) {
  if (provider === "mock") return createMockLanguageModel(modelId);
  // biome-ignore lint/suspicious/noExplicitAny: LlmProviderKind is broader
  return await resolveSdkModel(provider as any, modelId);
}
