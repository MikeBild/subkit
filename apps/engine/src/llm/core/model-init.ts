import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export const DIRECT_PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "gemini",
  "azure",
  "bedrock",
  "vertex",
] as const;

export type DirectProviderKind = (typeof DIRECT_PROVIDER_KINDS)[number];
export type ProviderKind = "gateway" | "mock" | DirectProviderKind;
export type ProviderState = ProviderKind | "unconfigured";

export interface ModelInitOptions {
  /** Env var that selects the provider kind. Default `LLM_PROVIDER`. */
  providerEnvVar?: string;
  /**
   * Explicit provider — when set, the env-derived selection is bypassed
   * entirely.
   */
  providerOverride?: ProviderKind;
  /** Default model id used when the provider env var does not supply one. */
  defaultModel?: string;
  /** If set, overrides any env-driven model choice. */
  modelOverride?: string;
}

export interface ResolvedModel {
  provider: ProviderKind;
  modelId: string;
  /** Value ready to hand to `generateText({ model })`. */
  model: LanguageModel | string;
}

export class ProviderMisconfiguredError extends Error {
  constructor(providerKind: ProviderKind | "gateway", detail: string) {
    super(`LLM provider '${providerKind}' is misconfigured: ${detail}`);
    this.name = "ProviderMisconfiguredError";
  }
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function requireEnv(name: string, provider: ProviderKind): string {
  const value = readEnv(name);
  if (!value) {
    throw new ProviderMisconfiguredError(provider, `${name} is not set.`);
  }
  return value;
}

function isDirectProviderKind(value: string): value is DirectProviderKind {
  return DIRECT_PROVIDER_KINDS.includes(value as DirectProviderKind);
}

export function detectConfiguredProvider(options?: {
  providerEnvVar?: string;
  providerOverride?: ProviderKind;
}): ProviderState {
  if (options?.providerOverride) return options.providerOverride;

  const providerEnvVar = options?.providerEnvVar ?? "LLM_PROVIDER";
  if (readEnv("AI_GATEWAY_API_KEY") && readEnv("AI_GATEWAY_MODEL")) {
    return "gateway";
  }

  const envProvider = (readEnv(providerEnvVar) ?? "").toLowerCase();
  if (envProvider === "mock") return "mock";
  if (isDirectProviderKind(envProvider)) return envProvider;
  return "unconfigured";
}

function resolveGatewayModel(defaultModel: string, modelOverride?: string): ResolvedModel {
  requireEnv("AI_GATEWAY_API_KEY", "gateway");
  const gatewayModel = requireEnv("AI_GATEWAY_MODEL", "gateway");
  const modelId = modelOverride ?? gatewayModel ?? defaultModel;
  return {
    provider: "gateway",
    modelId,
    model: modelId,
  };
}

function resolveAnthropic(defaultModel: string, modelOverride?: string): ResolvedModel {
  const modelId = modelOverride ?? readEnv("ANTHROPIC_MODEL") ?? defaultModel;
  const anthropicOptions: Record<string, unknown> = {
    apiKey: requireEnv("ANTHROPIC_API_KEY", "anthropic"),
    headers: { "anthropic-beta": "context-1m-2025-08-07" },
  };
  const baseURL = readEnv("ANTHROPIC_BASE_URL");
  if (baseURL) anthropicOptions.baseURL = baseURL;
  const provider = createAnthropic(anthropicOptions);
  return {
    provider: "anthropic",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

function resolveOpenAi(defaultModel: string, modelOverride?: string): ResolvedModel {
  const modelId = modelOverride ?? readEnv("OPENAI_MODEL") ?? defaultModel;
  const openaiOptions: Record<string, unknown> = {
    apiKey: requireEnv("OPENAI_API_KEY", "openai"),
  };
  const baseURL = readEnv("OPENAI_BASE_URL");
  if (baseURL) openaiOptions.baseURL = baseURL;
  const provider = createOpenAI(openaiOptions);
  return {
    provider: "openai",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

function resolveGemini(defaultModel: string, modelOverride?: string): ResolvedModel {
  const modelId = modelOverride ?? readEnv("GEMINI_MODEL") ?? defaultModel;
  const geminiOptions: Record<string, unknown> = {
    apiKey: requireEnv("GEMINI_API_KEY", "gemini"),
  };
  const baseURL = readEnv("GEMINI_BASE_URL");
  if (baseURL) geminiOptions.baseURL = baseURL;
  const provider = createGoogleGenerativeAI(geminiOptions);
  return {
    provider: "gemini",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

function resolveAzure(defaultModel: string, modelOverride?: string): ResolvedModel {
  const modelId = modelOverride ?? readEnv("AZURE_MODEL") ?? defaultModel;
  const azureOptions: Record<string, unknown> = {
    apiKey: requireEnv("AZURE_API_KEY", "azure"),
  };
  const resourceName = readEnv("AZURE_RESOURCE_NAME");
  const baseURL = readEnv("AZURE_BASE_URL");
  if (!resourceName && !baseURL) {
    throw new ProviderMisconfiguredError(
      "azure",
      "Either AZURE_RESOURCE_NAME or AZURE_BASE_URL needs to be set.",
    );
  }
  if (resourceName) azureOptions.resourceName = resourceName;
  if (baseURL) azureOptions.baseURL = baseURL;
  const apiVersion = readEnv("AZURE_API_VERSION");
  if (apiVersion) azureOptions.apiVersion = apiVersion;
  const deploymentBasedUrls = readEnv("AZURE_USE_DEPLOYMENT_BASED_URLS");
  if (deploymentBasedUrls !== undefined) {
    azureOptions.useDeploymentBasedUrls = deploymentBasedUrls === "true";
  }
  const provider = createAzure(azureOptions);
  return {
    provider: "azure",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

function resolveBedrock(defaultModel: string, modelOverride?: string): ResolvedModel {
  const modelId = modelOverride ?? readEnv("BEDROCK_MODEL") ?? defaultModel;
  const bedrockOptions: Record<string, unknown> = {
    region: requireEnv("AWS_REGION", "bedrock"),
    accessKeyId: requireEnv("AWS_ACCESS_KEY_ID", "bedrock"),
    secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY", "bedrock"),
  };
  const sessionToken = readEnv("AWS_SESSION_TOKEN");
  if (sessionToken) bedrockOptions.sessionToken = sessionToken;
  const baseURL = readEnv("AWS_BASE_URL");
  if (baseURL) bedrockOptions.baseURL = baseURL;
  const provider = createAmazonBedrock(bedrockOptions);
  return {
    provider: "bedrock",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

function resolveVertex(defaultModel: string, modelOverride?: string): ResolvedModel {
  const modelId = modelOverride ?? readEnv("VERTEX_MODEL") ?? defaultModel;
  const vertexApiKey = readEnv("VERTEX_API_KEY");
  const vertexClientEmail = readEnv("VERTEX_CLIENT_EMAIL");
  const vertexPrivateKey = readEnv("VERTEX_PRIVATE_KEY");
  const googleCredentials = readEnv("GOOGLE_APPLICATION_CREDENTIALS");
  if (!vertexApiKey && !(vertexClientEmail && vertexPrivateKey) && !googleCredentials) {
    throw new ProviderMisconfiguredError(
      "vertex",
      "Vertex requires VERTEX_API_KEY, VERTEX_CLIENT_EMAIL + VERTEX_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS.",
    );
  }

  if (modelId.startsWith("claude")) {
    const anthropicVertexOptions: Record<string, unknown> = {};
    const project = readEnv("VERTEX_PROJECT");
    const location = readEnv("VERTEX_LOCATION");
    if (project) anthropicVertexOptions.project = project;
    if (location) anthropicVertexOptions.location = location;
    if (vertexClientEmail && vertexPrivateKey) {
      anthropicVertexOptions.googleAuthOptions = {
        credentials: {
          client_email: vertexClientEmail,
          private_key: vertexPrivateKey,
        },
      };
    } else if (googleCredentials) {
      anthropicVertexOptions.googleAuthOptions = {
        keyFilename: googleCredentials,
      };
    }
    const provider = createVertexAnthropic(anthropicVertexOptions);
    return {
      provider: "vertex",
      modelId,
      model: provider(modelId) as unknown as LanguageModel,
    };
  }

  const vertexOptions: Record<string, unknown> = {};
  if (vertexApiKey) vertexOptions.apiKey = vertexApiKey;
  const project = readEnv("VERTEX_PROJECT");
  const location = readEnv("VERTEX_LOCATION");
  if (project) vertexOptions.project = project;
  if (location) vertexOptions.location = location;
  const provider = createVertex(vertexOptions);
  return {
    provider: "vertex",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

/**
 * Resolve a model ready for `generateText`.
 *
 * Precedence:
 *   1. Explicit provider override when present.
 *   2. Gateway mode when both `AI_GATEWAY_API_KEY` and `AI_GATEWAY_MODEL` exist.
 *   3. Direct provider mode via `LLM_PROVIDER`.
 *   4. Mock sentinel when explicitly requested.
 */
export async function initializeModel(options?: ModelInitOptions): Promise<ResolvedModel> {
  const providerEnvVar = options?.providerEnvVar ?? "LLM_PROVIDER";
  const defaultModel = options?.defaultModel ?? "claude-sonnet-4-5";
  const modelOverride = options?.modelOverride;

  const provider = detectConfiguredProvider({
    providerEnvVar,
    ...(options?.providerOverride ? { providerOverride: options.providerOverride } : {}),
  });

  if (provider === "unconfigured") {
    throw new ProviderMisconfiguredError(
      "gateway",
      `No LLM provider configured. Set AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL for gateway mode, or set ${providerEnvVar} to one of: ${DIRECT_PROVIDER_KINDS.join(", ")}, mock.`,
    );
  }

  if (provider === "mock") {
    return {
      provider: "mock",
      modelId: modelOverride ?? defaultModel,
      model: "mock:never-dispatched",
    };
  }

  switch (provider) {
    case "gateway":
      return resolveGatewayModel(defaultModel, modelOverride);
    case "anthropic":
      return resolveAnthropic(defaultModel, modelOverride);
    case "openai":
      return resolveOpenAi(defaultModel, modelOverride);
    case "gemini":
      return resolveGemini(defaultModel, modelOverride);
    case "azure":
      return resolveAzure(defaultModel, modelOverride);
    case "bedrock":
      return resolveBedrock(defaultModel, modelOverride);
    case "vertex":
      return resolveVertex(defaultModel, modelOverride);
  }
}
