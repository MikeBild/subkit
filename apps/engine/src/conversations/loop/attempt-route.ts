import type { LlmProviderKind, ModelRoute } from "../../llm/types.ts";

export interface ConversationAttemptRoute {
  model: string;
  provider: LlmProviderKind;
}

export function resolveConversationAttemptRoutes(
  route: ModelRoute,
  seedModel: string,
): { primary: ConversationAttemptRoute; fallback: ConversationAttemptRoute } {
  return {
    primary: { model: seedModel, provider: route.provider },
    fallback: { model: route.fallback, provider: route.fallback_provider },
  };
}
