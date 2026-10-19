import type { Executor } from "../../db/client.ts";
import { resolveLanguageModel as resolveSdkModel } from "../../llm/core/invoke.ts";
import { createMockLanguageModel } from "../../llm/mock-stream.ts";
import type { LlmProviderKind } from "../../llm/types.ts";

export const DEFAULT_BUDGET = 24;

export const MAX_REPAIRS_PER_TURN = 2;

export type LoopProviderKind = LlmProviderKind | "mock";

export function answeringModelLabel(provider: LoopProviderKind, modelId: string): string {
  return provider === "mock" ? `mock:${modelId}` : modelId;
}

export async function resolveLanguageModel(
  provider: LoopProviderKind,
  modelId: string,
  tenantId?: string,
  exec?: Executor,
) {
  if (provider === "mock") return createMockLanguageModel(modelId);
  return await resolveSdkModel(provider, modelId, tenantId, exec);
}
