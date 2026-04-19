// Model initialisation — single path via Vercel AI SDK + AI Gateway.
//
// Production + dev real-LLM path: Vercel AI Gateway. `AI_GATEWAY_API_KEY`
// authorises the engine against `https://ai-gateway.vercel.ai`; `ai` reads
// the env var internally and a plain model string like
// `anthropic/claude-sonnet-4-5` is enough for `streamText({ model })`.
//
// Tests: `LLM_PROVIDER=mock` returns a sentinel string that the conversation
// loop short-circuits before it ever reaches `streamText`.
//
// There is no third path. Per-provider SDK packages (`@ai-sdk/anthropic`,
// `@ai-sdk/openai`, `@ai-sdk/google`) used to be dynamically imported here,
// but the compiled `--compile` binary silently loses those imports and the
// engine 500s on every conversation in production. The Gateway covers every
// provider we actually use; fail fast with a clear error if its key is
// missing rather than chase runtime module-resolution issues.

import type { LanguageModel } from "ai";

export interface ModelInitOptions {
  /** Env var that selects the provider kind. Default `LLM_PROVIDER`. */
  providerEnvVar?: string;
  /**
   * Explicit provider — when set, the env-derived selection is bypassed
   * entirely. Callers that already resolved the provider (e.g. via
   * `resolveModelRoute` against tenant settings) MUST pass this so the
   * dispatch path cannot silently disagree with the route decision and
   * fall through to the mock sentinel.
   */
  providerOverride?: ProviderKind;
  /** Default model id used when the provider env var does not supply one. */
  defaultModel?: string;
  /** If set, overrides any env-driven model choice. */
  modelOverride?: string;
}

export type ProviderKind = "gateway" | "mock";

export interface ResolvedModel {
  provider: ProviderKind;
  modelId: string;
  /** Value ready to hand to `generateText({ model })`. */
  model: LanguageModel | string;
}

export class ProviderMisconfiguredError extends Error {
  constructor(providerKind: ProviderKind, detail: string) {
    super(`LLM provider '${providerKind}' is misconfigured: ${detail}`);
    this.name = "ProviderMisconfiguredError";
  }
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Resolve a model ready for `generateText`. Gateway mode is preferred when
 * `AI_GATEWAY_API_KEY` + `AI_GATEWAY_MODEL` (or explicit override) are set.
 * Otherwise a mock sentinel string is returned for test short-circuiting.
 */
export async function initializeModel(options?: ModelInitOptions): Promise<ResolvedModel> {
  const providerEnvVar = options?.providerEnvVar ?? "LLM_PROVIDER";
  const defaultModel = options?.defaultModel ?? "claude-sonnet-4-5";
  const modelOverride = options?.modelOverride;

  // Mock path: tests set LLM_PROVIDER=mock (or callers pass
  // providerOverride="mock") to get a sentinel string. Short-circuited
  // before `streamText` ever sees it.
  const providerOverride = options?.providerOverride;
  const envProvider = (readEnv(providerEnvVar) ?? "").toLowerCase();
  const mockRequested =
    providerOverride === "mock" || (providerOverride === undefined && envProvider === "mock");
  if (mockRequested) {
    return {
      provider: "mock",
      modelId: modelOverride ?? defaultModel,
      model: "mock:never-dispatched",
    };
  }

  // Real-LLM path: Vercel AI Gateway. `AI_GATEWAY_API_KEY` authorises
  // the call; model is a plain string the `ai` SDK routes via the
  // gateway. No per-provider SDK package involved.
  const gatewayKey = readEnv("AI_GATEWAY_API_KEY");
  if (!gatewayKey) {
    throw new ProviderMisconfiguredError(
      "gateway",
      "AI_GATEWAY_API_KEY not set. Configure it in the engine environment or set LLM_PROVIDER=mock for tests.",
    );
  }
  const gatewayModel = readEnv("AI_GATEWAY_MODEL") ?? defaultModel;
  return {
    provider: "gateway",
    modelId: modelOverride ?? gatewayModel,
    model: modelOverride ?? gatewayModel,
  };
}
