import type { LlmProviderKind, ModelRoute } from "../../llm/types.ts";

export interface ConversationAttemptRoute {
  model: string;
  provider: LlmProviderKind;
}

/**
 * Keep model and provider inseparable across a turn-level fallback.
 * Passing only the fallback model used to route an OpenAI model id through
 * the primary Anthropic provider, which repeated the original quota error.
 */
export function resolveConversationAttemptRoutes(
  route: ModelRoute,
  seedModel: string,
): { primary: ConversationAttemptRoute; fallback: ConversationAttemptRoute } {
  return {
    primary: { model: seedModel, provider: route.provider },
    fallback: { model: route.fallback, provider: route.fallback_provider },
  };
}
