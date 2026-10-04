import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel, Tool } from "ai";
import { getConfig } from "../../config/loader.ts";

const CONFIG_UNINITIALIZED = Symbol("config_uninitialized");

const ENV_TO_CONFIG_PATH: Record<string, string[]> = {
  LLM_PROVIDER: ["llm", "provider"],
  LLM_FALLBACK_PROVIDER: ["llm", "fallback_provider"],
  SUMMARIZE_LLM_PROVIDER: ["llm", "summarize_provider"],
  SUMMARIZE_MODEL: ["llm", "summarize_model"],
  LLM_CONTEXT_1M: ["llm", "context_1m"],
  ANTHROPIC_API_KEY: ["llm", "providers", "anthropic", "api_key"],
  ANTHROPIC_MODEL: ["llm", "providers", "anthropic", "model"],
  ANTHROPIC_BASE_URL: ["llm", "providers", "anthropic", "base_url"],
  OPENAI_API_KEY: ["llm", "providers", "openai", "api_key"],
  OPENAI_MODEL: ["llm", "providers", "openai", "model"],
  OPENAI_BASE_URL: ["llm", "providers", "openai", "base_url"],
  GEMINI_API_KEY: ["llm", "providers", "gemini", "api_key"],
  GEMINI_MODEL: ["llm", "providers", "gemini", "model"],
  GEMINI_BASE_URL: ["llm", "providers", "gemini", "base_url"],
  AZURE_API_KEY: ["llm", "providers", "azure", "api_key"],
  AZURE_MODEL: ["llm", "providers", "azure", "model"],
  AZURE_BASE_URL: ["llm", "providers", "azure", "base_url"],
  AZURE_RESOURCE_NAME: ["llm", "providers", "azure", "resource_name"],
  AZURE_API_VERSION: ["llm", "providers", "azure", "api_version"],
  AZURE_USE_DEPLOYMENT_BASED_URLS: ["llm", "providers", "azure", "use_deployment_based_urls"],
  BEDROCK_MODEL: ["llm", "providers", "bedrock", "model"],
  AWS_REGION: ["llm", "providers", "bedrock", "region"],
  AWS_ACCESS_KEY_ID: ["llm", "providers", "bedrock", "access_key_id"],
  AWS_SECRET_ACCESS_KEY: ["llm", "providers", "bedrock", "secret_access_key"],
  AWS_SESSION_TOKEN: ["llm", "providers", "bedrock", "session_token"],
  AWS_BASE_URL: ["llm", "providers", "bedrock", "base_url"],
  VERTEX_API_KEY: ["llm", "providers", "vertex", "api_key"],
  VERTEX_MODEL: ["llm", "providers", "vertex", "model"],
  VERTEX_PROJECT: ["llm", "providers", "vertex", "project"],
  VERTEX_LOCATION: ["llm", "providers", "vertex", "location"],
  VERTEX_CLIENT_EMAIL: ["llm", "providers", "vertex", "client_email"],
  VERTEX_PRIVATE_KEY: ["llm", "providers", "vertex", "private_key"],
  GOOGLE_APPLICATION_CREDENTIALS: ["llm", "providers", "vertex", "google_application_credentials"],
  GOOGLE_VERTEX_PROJECT: ["llm", "providers", "vertex", "project"],
  GOOGLE_VERTEX_LOCATION: ["llm", "providers", "vertex", "location"],
  AI_GATEWAY_API_KEY: ["llm", "providers", "ai_gateway", "api_key"],
  AI_GATEWAY_MODEL: ["llm", "providers", "ai_gateway", "model"],
};

function readConfigByPath(p: string[], tenantId?: string): unknown | typeof CONFIG_UNINITIALIZED {
  let cfg: unknown;
  try {
    cfg = getConfig(tenantId);
  } catch {
    return CONFIG_UNINITIALIZED;
  }
  for (const seg of p) {
    if (typeof cfg !== "object" || cfg === null) return undefined;
    cfg = (cfg as Record<string, unknown>)[seg];
  }
  return cfg;
}

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
  providerEnvVar?: string;
  tenantId?: string;
  providerOverride?: ProviderKind;
  defaultModel?: string;
  modelOverride?: string;
}

export interface ResolvedModel {
  provider: ProviderKind;
  modelId: string;
  model: LanguageModel | string;
}

export class ProviderMisconfiguredError extends Error {
  constructor(providerKind: ProviderKind | "gateway", detail: string) {
    super(`LLM provider '${providerKind}' is misconfigured: ${detail}`);
    this.name = "ProviderMisconfiguredError";
  }
}

function readEnv(name: string, tenantId?: string): string | undefined {
  const cfgPath = ENV_TO_CONFIG_PATH[name];
  if (cfgPath) {
    const v = readConfigByPath(cfgPath, tenantId);
    if (v !== CONFIG_UNINITIALIZED) {
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "number") return String(v);
      return undefined;
    }
  }
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : undefined;
}

function requireEnv(name: string, provider: ProviderKind, tenantId?: string): string {
  const value = readEnv(name, tenantId);
  if (!value) {
    throw new ProviderMisconfiguredError(
      provider,
      `${name} is not set. Configure it in the Cockpit, settings API, or with \`sk settings configure\`.`,
    );
  }
  return value;
}

function isDirectProviderKind(value: string): value is DirectProviderKind {
  return DIRECT_PROVIDER_KINDS.includes(value as DirectProviderKind);
}

export interface ProviderSetupReport {
  detected: ProviderState;
  ok: boolean;
  message: string;
  missing: ReadonlyArray<string>;
}

const PROVIDER_REQUIREMENTS: Record<DirectProviderKind, ReadonlyArray<string>> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  azure: ["AZURE_API_KEY"],
  bedrock: ["AWS_REGION"],
  vertex: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION"],
};

export function validateProviderSetup(): ProviderSetupReport {
  const detected = detectConfiguredProvider();
  if (detected === "unconfigured") {
    return {
      detected,
      ok: false,
      message: "no LLM provider configured — set LLM_PROVIDER and the matching credentials",
      missing: ["LLM_PROVIDER"],
    };
  }
  if (detected === "mock" || detected === "gateway") {
    if (detected === "gateway") {
      const missing: string[] = [];
      if (!readEnv("AI_GATEWAY_API_KEY")) missing.push("AI_GATEWAY_API_KEY");
      if (!readEnv("AI_GATEWAY_MODEL")) missing.push("AI_GATEWAY_MODEL");
      if (missing.length > 0) {
        return {
          detected,
          ok: false,
          message: `gateway provider missing: ${missing.join(", ")}`,
          missing,
        };
      }
    }
    return { detected, ok: true, message: `provider=${detected} ready`, missing: [] };
  }
  const required = PROVIDER_REQUIREMENTS[detected];
  const missing = required.filter((name) => !readEnv(name));
  if (detected === "azure" && missing.length === 0) {
    if (!readEnv("AZURE_RESOURCE_NAME") && !readEnv("AZURE_BASE_URL")) {
      return {
        detected,
        ok: false,
        message: "azure: either AZURE_RESOURCE_NAME or AZURE_BASE_URL must be set",
        missing: ["AZURE_RESOURCE_NAME|AZURE_BASE_URL"],
      };
    }
  }
  if (missing.length > 0) {
    return {
      detected,
      ok: false,
      message: `${detected}: missing ${missing.join(", ")}`,
      missing,
    };
  }
  return { detected, ok: true, message: `provider=${detected} ready`, missing: [] };
}

export function detectConfiguredProvider(options?: {
  providerEnvVar?: string;
  providerOverride?: ProviderKind;
  tenantId?: string;
}): ProviderState {
  if (options?.providerOverride) return options.providerOverride;

  const providerEnvVar = options?.providerEnvVar ?? "LLM_PROVIDER";
  if (
    readEnv("AI_GATEWAY_API_KEY", options?.tenantId) &&
    readEnv("AI_GATEWAY_MODEL", options?.tenantId)
  ) {
    return "gateway";
  }

  const envProvider = (readEnv(providerEnvVar, options?.tenantId) ?? "").toLowerCase();
  if (envProvider === "mock") return "mock";
  if (isDirectProviderKind(envProvider)) return envProvider;
  return "unconfigured";
}

function resolveGatewayModel(
  defaultModel: string,
  modelOverride?: string,
  tenantId?: string,
): ResolvedModel {
  requireEnv("AI_GATEWAY_API_KEY", "gateway", tenantId);
  const gatewayModel = requireEnv("AI_GATEWAY_MODEL", "gateway", tenantId);
  const modelId = modelOverride ?? gatewayModel ?? defaultModel;
  return {
    provider: "gateway",
    modelId,
    model: modelId,
  };
}

function anthropicOptions(tenantId?: string): Record<string, unknown> {
  const options: Record<string, unknown> = {
    apiKey: requireEnv("ANTHROPIC_API_KEY", "anthropic", tenantId),
    headers: { "anthropic-beta": "context-1m-2025-08-07" },
  };
  const baseURL = readEnv("ANTHROPIC_BASE_URL", tenantId);
  if (baseURL) options.baseURL = baseURL;
  return options;
}

function resolveAnthropic(
  defaultModel: string,
  modelOverride?: string,
  tenantId?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("ANTHROPIC_MODEL", tenantId) ?? defaultModel;
  const provider = createAnthropic(anthropicOptions(tenantId));
  return {
    provider: "anthropic",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

export function anthropicWebSearchApplies(
  provider: string,
  modelId: string,
  enabled: boolean,
): boolean {
  return provider === "anthropic" && /claude/i.test(modelId) && enabled === true;
}

export function buildAnthropicWebSearchTool(maxUses: number): Tool {
  const provider = createAnthropic(anthropicOptions());
  return provider.tools.webSearch_20250305({ maxUses }) as unknown as Tool;
}

export function readOpenAiBaseUrl(tenantId?: string): string | undefined {
  return readEnv("OPENAI_BASE_URL", tenantId);
}

function resolveOpenAi(
  defaultModel: string,
  modelOverride?: string,
  tenantId?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("OPENAI_MODEL", tenantId) ?? defaultModel;
  const openaiOptions: Record<string, unknown> = {
    apiKey: requireEnv("OPENAI_API_KEY", "openai", tenantId),
  };
  const baseURL = readOpenAiBaseUrl(tenantId);
  if (baseURL) openaiOptions.baseURL = baseURL;
  const provider = createOpenAI(openaiOptions);
  const model = (baseURL ? provider.chat(modelId) : provider(modelId)) as unknown as LanguageModel;
  return {
    provider: "openai",
    modelId,
    model,
  };
}

function resolveGemini(
  defaultModel: string,
  modelOverride?: string,
  tenantId?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("GEMINI_MODEL", tenantId) ?? defaultModel;
  const geminiOptions: Record<string, unknown> = {
    apiKey: requireEnv("GEMINI_API_KEY", "gemini", tenantId),
  };
  const baseURL = readEnv("GEMINI_BASE_URL", tenantId);
  if (baseURL) geminiOptions.baseURL = baseURL;
  const provider = createGoogleGenerativeAI(geminiOptions);
  return {
    provider: "gemini",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

function resolveAzure(
  defaultModel: string,
  modelOverride?: string,
  tenantId?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("AZURE_MODEL", tenantId) ?? defaultModel;
  const azureOptions: Record<string, unknown> = {
    apiKey: requireEnv("AZURE_API_KEY", "azure", tenantId),
  };
  const resourceName = readEnv("AZURE_RESOURCE_NAME", tenantId);
  const baseURL = readEnv("AZURE_BASE_URL", tenantId);
  if (!resourceName && !baseURL) {
    throw new ProviderMisconfiguredError(
      "azure",
      "Either AZURE_RESOURCE_NAME or AZURE_BASE_URL needs to be set.",
    );
  }
  if (resourceName) azureOptions.resourceName = resourceName;
  if (baseURL) azureOptions.baseURL = baseURL;
  const apiVersion = readEnv("AZURE_API_VERSION", tenantId);
  if (apiVersion) azureOptions.apiVersion = apiVersion;
  const deploymentBasedUrls = readEnv("AZURE_USE_DEPLOYMENT_BASED_URLS", tenantId);
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

function resolveBedrock(
  defaultModel: string,
  modelOverride?: string,
  tenantId?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("BEDROCK_MODEL", tenantId) ?? defaultModel;
  const bedrockOptions: Record<string, unknown> = {
    region: requireEnv("AWS_REGION", "bedrock", tenantId),
    accessKeyId: requireEnv("AWS_ACCESS_KEY_ID", "bedrock", tenantId),
    secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY", "bedrock", tenantId),
  };
  const sessionToken = readEnv("AWS_SESSION_TOKEN", tenantId);
  if (sessionToken) bedrockOptions.sessionToken = sessionToken;
  const baseURL = readEnv("AWS_BASE_URL", tenantId);
  if (baseURL) bedrockOptions.baseURL = baseURL;
  const provider = createAmazonBedrock(bedrockOptions);
  return {
    provider: "bedrock",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

function resolveVertex(
  defaultModel: string,
  modelOverride?: string,
  tenantId?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("VERTEX_MODEL", tenantId) ?? defaultModel;
  const vertexApiKey = readEnv("VERTEX_API_KEY", tenantId);
  const vertexClientEmail = readEnv("VERTEX_CLIENT_EMAIL", tenantId);
  const vertexPrivateKey = readEnv("VERTEX_PRIVATE_KEY", tenantId);
  const googleCredentials = readEnv("GOOGLE_APPLICATION_CREDENTIALS", tenantId);
  if (!vertexApiKey && !(vertexClientEmail && vertexPrivateKey) && !googleCredentials) {
    throw new ProviderMisconfiguredError(
      "vertex",
      "Vertex requires VERTEX_API_KEY, VERTEX_CLIENT_EMAIL + VERTEX_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS.",
    );
  }

  if (modelId.startsWith("claude")) {
    const anthropicVertexOptions: Record<string, unknown> = {};
    const project = readEnv("VERTEX_PROJECT", tenantId);
    const location = readEnv("VERTEX_LOCATION", tenantId);
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
  const project = readEnv("VERTEX_PROJECT", tenantId);
  const location = readEnv("VERTEX_LOCATION", tenantId);
  if (project) vertexOptions.project = project;
  if (location) vertexOptions.location = location;
  const provider = createVertex(vertexOptions);
  return {
    provider: "vertex",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

export const DEFAULT_INIT_MODEL = "claude-sonnet-4-6";

export async function initializeModel(options?: ModelInitOptions): Promise<ResolvedModel> {
  const providerEnvVar = options?.providerEnvVar ?? "LLM_PROVIDER";
  const defaultModel = options?.defaultModel ?? DEFAULT_INIT_MODEL;
  const modelOverride = options?.modelOverride;
  const tenantId = options?.tenantId;

  const provider = detectConfiguredProvider({
    providerEnvVar,
    ...(tenantId ? { tenantId } : {}),
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
      return resolveGatewayModel(defaultModel, modelOverride, tenantId);
    case "anthropic":
      return resolveAnthropic(defaultModel, modelOverride, tenantId);
    case "openai":
      return resolveOpenAi(defaultModel, modelOverride, tenantId);
    case "gemini":
      return resolveGemini(defaultModel, modelOverride, tenantId);
    case "azure":
      return resolveAzure(defaultModel, modelOverride, tenantId);
    case "bedrock":
      return resolveBedrock(defaultModel, modelOverride, tenantId);
    case "vertex":
      return resolveVertex(defaultModel, modelOverride, tenantId);
  }
}
