// Model initialisation — gateway-first, provider packages via dynamic import.
//
// Rationale (per architecture plan §5.1 + §I):
//   - Production path: Vercel AI Gateway. Model is a plain string (e.g.
//     `anthropic/claude-sonnet-4-5`) passed straight to `ai`'s
//     `generateText({ model: <string>, ... })`. Zero provider packages
//     required in the dependency graph.
//   - Dev/test path: a provider package is loaded on demand via dynamic
//     `import()`. If the package is not installed, callers get a clear
//     `ProviderNotInstalledError` — not a cryptic module resolution error
//     at engine boot.
//
// Every other call-site in the engine imports only from `ai`. This file is
// the single seam where a provider-specific factory (e.g. `createAnthropic`)
// may be referenced — and only behind a dynamic import.

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

export type ProviderKind =
  | "gateway"
  | "anthropic"
  | "openai"
  | "gemini"
  | "azure"
  | "bedrock"
  | "vertex"
  | "mock";

export interface ResolvedModel {
  provider: ProviderKind;
  modelId: string;
  /** Value ready to hand to `generateText({ model })`. */
  model: LanguageModel | string;
}

export class ProviderNotInstalledError extends Error {
  readonly providerPackage: string;
  constructor(providerKind: ProviderKind, pkg: string) {
    super(
      `LLM provider '${providerKind}' requires the '${pkg}' package. ` +
        `Install with: bun add ${pkg}`,
    );
    this.name = "ProviderNotInstalledError";
    this.providerPackage = pkg;
  }
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
 * Otherwise we fall back to `LLM_PROVIDER` + provider-specific env vars.
 */
export async function initializeModel(options?: ModelInitOptions): Promise<ResolvedModel> {
  const providerEnvVar = options?.providerEnvVar ?? "LLM_PROVIDER";
  const defaultModel = options?.defaultModel ?? "claude-sonnet-4-5";
  const modelOverride = options?.modelOverride;

  // Gateway mode: AI_GATEWAY_API_KEY is present → return the gateway model
  // string. The `ai` package reads AI_GATEWAY_API_KEY at call time.
  const gatewayKey = readEnv("AI_GATEWAY_API_KEY");
  const gatewayModel = readEnv("AI_GATEWAY_MODEL") ?? (gatewayKey ? defaultModel : undefined);
  if (gatewayKey && gatewayModel) {
    return {
      provider: "gateway",
      modelId: modelOverride ?? gatewayModel,
      model: modelOverride ?? gatewayModel,
    };
  }

  // Provider precedence:
  //   1. Explicit `providerOverride` (set by callers that already
  //      resolved a provider — e.g. `resolveLanguageModel` in
  //      conversations/loop.ts). This MUST win, otherwise the dispatch
  //      path silently falls back to mock when LLM_PROVIDER is unset
  //      even though `ANTHROPIC_API_KEY` is present, and every
  //      conversation 500s with a `mock:never-dispatched` sentinel
  //      hitting the AI SDK.
  //   2. The configured env var (default LLM_PROVIDER).
  //   3. Mock fallback when neither resolves.
  const providerType = (options?.providerOverride ?? readEnv(providerEnvVar) ?? "").toLowerCase();

  if (providerType === "mock" || providerType === "") {
    // Caller is responsible for short-circuiting the mock path before it
    // ever reaches `generateText`. We return a sentinel string that will
    // hard-fail if dispatched to the SDK unchecked.
    return {
      provider: "mock",
      modelId: modelOverride ?? defaultModel,
      model: "mock:never-dispatched",
    };
  }

  switch (providerType) {
    case "anthropic": {
      const apiKey = readEnv("ANTHROPIC_API_KEY");
      if (!apiKey) throw new ProviderMisconfiguredError("anthropic", "ANTHROPIC_API_KEY not set");
      const mod = await tryImport("@ai-sdk/anthropic", "anthropic");
      const { createAnthropic } = mod as {
        createAnthropic: (opts: Record<string, unknown>) => (id: string) => LanguageModel;
      };
      const provider = createAnthropic({
        apiKey,
        ...(readEnv("ANTHROPIC_BASE_URL") ? { baseURL: readEnv("ANTHROPIC_BASE_URL") } : {}),
      });
      const modelId = modelOverride ?? readEnv("ANTHROPIC_MODEL") ?? defaultModel;
      return { provider: "anthropic", modelId, model: provider(modelId) };
    }
    case "openai": {
      const apiKey = readEnv("OPENAI_API_KEY");
      if (!apiKey) throw new ProviderMisconfiguredError("openai", "OPENAI_API_KEY not set");
      const mod = await tryImport("@ai-sdk/openai", "openai");
      const { createOpenAI } = mod as {
        createOpenAI: (opts: Record<string, unknown>) => (id: string) => LanguageModel;
      };
      const provider = createOpenAI({
        apiKey,
        ...(readEnv("OPENAI_BASE_URL") ? { baseURL: readEnv("OPENAI_BASE_URL") } : {}),
      });
      const modelId = modelOverride ?? readEnv("OPENAI_MODEL") ?? defaultModel;
      return { provider: "openai", modelId, model: provider(modelId) };
    }
    case "gemini": {
      const apiKey = readEnv("GEMINI_API_KEY");
      if (!apiKey) throw new ProviderMisconfiguredError("gemini", "GEMINI_API_KEY not set");
      const mod = await tryImport("@ai-sdk/google", "gemini");
      const { createGoogleGenerativeAI } = mod as {
        createGoogleGenerativeAI: (opts: Record<string, unknown>) => (id: string) => LanguageModel;
      };
      const provider = createGoogleGenerativeAI({ apiKey });
      const modelId = modelOverride ?? readEnv("GEMINI_MODEL") ?? defaultModel;
      return { provider: "gemini", modelId, model: provider(modelId) };
    }
    case "azure":
    case "bedrock":
    case "vertex": {
      throw new ProviderMisconfiguredError(
        providerType as ProviderKind,
        `provider '${providerType}' recognised but not wired in this build. Use AI_GATEWAY_API_KEY.`,
      );
    }
    default:
      throw new ProviderMisconfiguredError(
        (providerType || "unknown") as ProviderKind,
        `unknown LLM_PROVIDER '${providerType}'. Use gateway (set AI_GATEWAY_API_KEY) or one of: anthropic, openai, gemini, mock.`,
      );
  }
}

async function tryImport(pkg: string, kind: ProviderKind): Promise<unknown> {
  try {
    return await import(pkg);
  } catch (err) {
    // ESM "cannot find module" path — we intentionally do not list these
    // providers in package.json dependencies.
    if ((err as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND") {
      throw new ProviderNotInstalledError(kind, pkg);
    }
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      throw new ProviderNotInstalledError(kind, pkg);
    }
    throw err;
  }
}
