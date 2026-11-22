import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  addToolInputExamplesMiddleware,
  type LanguageModel,
  type Tool,
  wrapLanguageModel,
} from "ai";
import { getConfig } from "../../config/loader.ts";
import type { Executor } from "../../db/client.ts";
import { envSnapshot, isEnvKey } from "../../env.ts";
import { logger } from "../../logging/index.ts";
import {
  type CatalogModelProvider,
  DEFAULT_MODELS,
  type DefaultModelRole,
  defaultModelFor,
  isCatalogModelProvider,
  modelFamilyMismatch,
} from "../model-catalog-view.ts";
import { assertOperatorKeyAllowed, modelTenantContext } from "./operator-key-guard.ts";
import { fetchWithResponseTimeout } from "./response-timeout.ts";

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
type ProviderState = ProviderKind | "unconfigured";

export interface ModelInitOptions {
  exec?: Executor;
  providerEnvVar?: string;
  tenantId?: string;
  providerOverride?: ProviderKind;
  defaultModel?: string;
  modelOverride?: string;
  apiKeyOverride?: string;
}

export interface ResolvedModel {
  provider: ProviderKind;
  modelId: string;
  model: LanguageModel | string;
}

export class ProviderMisconfiguredError extends Error {
  readonly setting: string | null;
  constructor(providerKind: ProviderKind | "gateway", detail: string, setting?: string) {
    super(`LLM provider '${providerKind}' is misconfigured: ${detail}`);
    this.name = "ProviderMisconfiguredError";
    this.setting = setting ?? null;
  }
}

const PROVIDER_MODEL_SETTING: Record<DirectProviderKind, string> = {
  anthropic: "ANTHROPIC_MODEL",
  openai: "OPENAI_MODEL",
  gemini: "GEMINI_MODEL",
  azure: "AZURE_MODEL",
  bedrock: "BEDROCK_MODEL",
  vertex: "VERTEX_MODEL",
};

export function configuredProviderModel(
  provider: DirectProviderKind,
  tenantId?: string,
): string | undefined {
  return readEnv(PROVIDER_MODEL_SETTING[provider], tenantId);
}

const PROVIDER_BASE_URL_SETTING: Record<CatalogModelProvider, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  gemini: "GEMINI_BASE_URL",
};

export function enforcesModelFamily(provider: string, tenantId?: string): boolean {
  if (!isCatalogModelProvider(provider)) return false;
  return !readEnv(PROVIDER_BASE_URL_SETTING[provider], tenantId);
}

const PROVIDER_KEY_SETTING: Record<CatalogModelProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export type ModelKeyOwner = "workspace" | "operator";

function workspaceLlmOverlay(tenantId: string) {
  try {
    return getConfig().tenants[tenantId]?.llm;
  } catch {
    return undefined;
  }
}

export function workspaceOwnsProviderKey(tenantId: string, provider: string): boolean {
  if (!isCatalogModelProvider(provider)) return false;
  if (readEnv(PROVIDER_BASE_URL_SETTING[provider], tenantId)) return false;
  const effective = readEnv(PROVIDER_KEY_SETTING[provider], tenantId);
  const overlay = workspaceLlmOverlay(tenantId);
  if (!effective || !overlay) return false;
  return (
    overlay.providers?.[provider]?.api_key === effective ||
    (overlay.provider === provider && overlay.api_key === effective)
  );
}

function workspaceKeyProvider(
  tenantId: string,
  providerEnvVar: string,
): CatalogModelProvider | undefined {
  const overlay = workspaceLlmOverlay(tenantId);
  const provider = overlay?.provider;
  if (!provider || !isCatalogModelProvider(provider)) return undefined;
  if (!workspaceOwnsProviderKey(tenantId, provider)) return undefined;
  const route = ENV_TO_CONFIG_PATH[providerEnvVar]?.[1];
  const named = route ? (overlay as Record<string, unknown>)[route] : undefined;
  if (route !== "provider" && typeof named === "string" && named.length > 0) return undefined;
  return provider;
}

export function modelKeyOwner(
  provider: ProviderKind,
  tenantId: string | undefined,
  apiKeyOverride?: string,
): ModelKeyOwner {
  if (!isCatalogModelProvider(provider)) return "operator";
  if (apiKeyOverride) {
    return readEnv(PROVIDER_BASE_URL_SETTING[provider], tenantId) ? "operator" : "workspace";
  }
  return tenantId && workspaceOwnsProviderKey(tenantId, provider) ? "workspace" : "operator";
}

export function providerDefaultModel(
  provider: ProviderState,
  role: DefaultModelRole = "primary",
  tenantId?: string,
): string | undefined {
  if (provider === "unconfigured") return undefined;
  if (provider === "mock") return DEFAULT_MODELS.anthropic[role];
  if (provider === "gateway") return readEnv("AI_GATEWAY_MODEL", tenantId);
  const configured = configuredProviderModel(provider, tenantId);
  if (!isCatalogModelProvider(provider)) return configured;
  const preferred = role === "primary" ? configured : undefined;
  if (
    preferred &&
    !(enforcesModelFamily(provider, tenantId) && modelFamilyMismatch(provider, preferred))
  ) {
    return preferred;
  }
  return defaultModelFor(provider, role);
}

export function modelForProvider(
  provider: ProviderState,
  model: string | null | undefined,
  role: DefaultModelRole = "primary",
  tenantId?: string,
): string | undefined {
  const chosen = model?.trim();
  if (
    chosen &&
    !(enforcesModelFamily(provider, tenantId) && modelFamilyMismatch(provider, chosen))
  ) {
    return chosen;
  }
  if (chosen) {
    logger.warn({
      module: "llm",
      action: "model.family_mismatch",
      msg: "configured model belongs to another provider; using the provider default instead",
      provider,
      model: chosen,
    });
  }
  return providerDefaultModel(provider, role, tenantId);
}

export function missingModelError(provider: DirectProviderKind): ProviderMisconfiguredError {
  const setting = PROVIDER_MODEL_SETTING[provider];
  return new ProviderMisconfiguredError(
    provider,
    `no model or deployment is configured. Set llm.model or ${setting} in the Cockpit, settings API, or with \`subkit settings configure\`.`,
    setting,
  );
}

export function readLlmSetting(name: string, tenantId?: string): string | undefined {
  return readEnv(name, tenantId);
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
  const raw = isEnvKey(name) ? envSnapshot()[name] : undefined;
  return raw && raw.length > 0 ? raw : undefined;
}

function requireEnv(name: string, provider: ProviderKind, tenantId?: string): string {
  const value = readEnv(name, tenantId);
  if (!value) {
    throw new ProviderMisconfiguredError(
      provider,
      `${name} is not set. Configure it in the Cockpit, settings API, or with \`subkit settings configure\`.`,
      name,
    );
  }
  return value;
}

function isDirectProviderKind(value: string): value is DirectProviderKind {
  return DIRECT_PROVIDER_KINDS.includes(value as DirectProviderKind);
}

interface ProviderSetupReport {
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

export function validateProviderSetup(tenantId?: string): ProviderSetupReport {
  const detected = detectConfiguredProvider(tenantId ? { tenantId } : undefined);
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
      if (!readEnv("AI_GATEWAY_API_KEY", tenantId)) missing.push("AI_GATEWAY_API_KEY");
      if (!readEnv("AI_GATEWAY_MODEL", tenantId)) missing.push("AI_GATEWAY_MODEL");
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
  const missing = required.filter((name) => !readEnv(name, tenantId));
  if (detected === "azure" && missing.length === 0) {
    if (!readEnv("AZURE_RESOURCE_NAME", tenantId) && !readEnv("AZURE_BASE_URL", tenantId)) {
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
  const own = options?.tenantId
    ? workspaceKeyProvider(options.tenantId, providerEnvVar)
    : undefined;
  if (own) return own;
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

function anthropicOptions(tenantId?: string, apiKeyOverride?: string): Record<string, unknown> {
  const options: Record<string, unknown> = {
    apiKey: apiKeyOverride ?? requireEnv("ANTHROPIC_API_KEY", "anthropic", tenantId),
    headers: { "anthropic-beta": "context-1m-2025-08-07" },
    fetch: fetchWithResponseTimeout(),
  };
  const baseURL = readEnv("ANTHROPIC_BASE_URL", tenantId);
  if (baseURL) options.baseURL = baseURL;
  return options;
}

function resolveAnthropic(
  defaultModel: string,
  modelOverride?: string,
  tenantId?: string,
  apiKeyOverride?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("ANTHROPIC_MODEL", tenantId) ?? defaultModel;
  const provider = createAnthropic(anthropicOptions(tenantId, apiKeyOverride));
  return {
    provider: "anthropic",
    modelId,
    model: provider(modelId) as unknown as LanguageModel,
  };
}

export function nativeWebSearchSetting(tenantId?: string): boolean {
  try {
    return getConfig(tenantId).llm.web_search === true;
  } catch {
    return false;
  }
}

export function anthropicWebSearchApplies(
  provider: string,
  modelId: string,
  enabled: boolean,
): boolean {
  return provider === "anthropic" && /claude/i.test(modelId) && enabled === true;
}

export function buildAnthropicWebSearchTool(maxUses: number, tenantId?: string): Tool {
  const provider = createAnthropic(anthropicOptions(tenantId));
  return provider.tools.webSearch_20250305({ maxUses }) as unknown as Tool;
}

export function readOpenAiBaseUrl(tenantId?: string): string | undefined {
  return readEnv("OPENAI_BASE_URL", tenantId);
}

function resolveOpenAi(
  defaultModel: string,
  modelOverride?: string,
  tenantId?: string,
  apiKeyOverride?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("OPENAI_MODEL", tenantId) ?? defaultModel;
  const openaiOptions: Record<string, unknown> = {
    apiKey: apiKeyOverride ?? requireEnv("OPENAI_API_KEY", "openai", tenantId),
    fetch: fetchWithResponseTimeout(),
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
  apiKeyOverride?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("GEMINI_MODEL", tenantId) ?? defaultModel;
  const geminiOptions: Record<string, unknown> = {
    apiKey: apiKeyOverride ?? requireEnv("GEMINI_API_KEY", "gemini", tenantId),
    fetch: fetchWithResponseTimeout(),
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
  apiKeyOverride?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("AZURE_MODEL", tenantId) ?? defaultModel;
  const azureOptions: Record<string, unknown> = {
    apiKey: apiKeyOverride ?? requireEnv("AZURE_API_KEY", "azure", tenantId),
  };
  const resourceName = readEnv("AZURE_RESOURCE_NAME", tenantId);
  const baseURL = readEnv("AZURE_BASE_URL", tenantId);
  if (!resourceName && !baseURL) {
    throw new ProviderMisconfiguredError(
      "azure",
      "Either AZURE_RESOURCE_NAME or AZURE_BASE_URL needs to be set.",
      "AZURE_RESOURCE_NAME or AZURE_BASE_URL",
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
  azureOptions.fetch = fetchWithResponseTimeout();
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
  apiKeyOverride?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("BEDROCK_MODEL", tenantId) ?? defaultModel;
  const region = requireEnv("AWS_REGION", "bedrock", tenantId);
  const bedrockOptions: Record<string, unknown> = apiKeyOverride
    ? { region, apiKey: apiKeyOverride }
    : {
        region,
        accessKeyId: requireEnv("AWS_ACCESS_KEY_ID", "bedrock", tenantId),
        secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY", "bedrock", tenantId),
      };
  bedrockOptions.fetch = fetchWithResponseTimeout();
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
  apiKeyOverride?: string,
): ResolvedModel {
  const modelId = modelOverride ?? readEnv("VERTEX_MODEL", tenantId) ?? defaultModel;
  const vertexApiKey = apiKeyOverride ?? readEnv("VERTEX_API_KEY", tenantId);
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
    const anthropicVertexOptions: Record<string, unknown> = { fetch: fetchWithResponseTimeout() };
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

  const vertexOptions: Record<string, unknown> = { fetch: fetchWithResponseTimeout() };
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

export function sendsToolInputExamplesNatively(provider: ProviderKind, modelId: string): boolean {
  return provider === "anthropic" || (provider === "vertex" && modelId.startsWith("claude"));
}

export function withToolInputExamples(
  model: LanguageModel | string,
  provider: ProviderKind,
  modelId: string,
): LanguageModel | string {
  if (typeof model === "string") return model;
  if (sendsToolInputExamplesNatively(provider, modelId)) return model;
  return wrapLanguageModel({
    model: model as LanguageModelV4,
    middleware: addToolInputExamplesMiddleware(),
  });
}

async function resolveModel(options?: ModelInitOptions): Promise<ResolvedModel> {
  const providerEnvVar = options?.providerEnvVar ?? "LLM_PROVIDER";
  const requestedDefault = options?.defaultModel?.trim() || undefined;
  const requestedOverride = options?.modelOverride?.trim() || undefined;
  const tenantId = options?.tenantId;
  const apiKey = options?.apiKeyOverride;

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
      modelId: requestedOverride ?? requestedDefault ?? DEFAULT_MODELS.anthropic.primary,
      model: "mock:never-dispatched",
    };
  }

  if (provider === "gateway") {
    return resolveGatewayModel(requestedDefault ?? "", requestedOverride, tenantId);
  }

  const candidate =
    requestedOverride ?? configuredProviderModel(provider, tenantId) ?? requestedDefault;
  const modelId = modelForProvider(provider, candidate, "primary", tenantId);
  if (!modelId) throw missingModelError(provider);
  const defaultModel = modelId;
  const modelOverride = modelId;

  switch (provider) {
    case "anthropic":
      return resolveAnthropic(defaultModel, modelOverride, tenantId, apiKey);
    case "openai":
      return resolveOpenAi(defaultModel, modelOverride, tenantId, apiKey);
    case "gemini":
      return resolveGemini(defaultModel, modelOverride, tenantId, apiKey);
    case "azure":
      return resolveAzure(defaultModel, modelOverride, tenantId, apiKey);
    case "bedrock":
      return resolveBedrock(defaultModel, modelOverride, tenantId, apiKey);
    case "vertex":
      return resolveVertex(defaultModel, modelOverride, tenantId, apiKey);
  }
}

export async function initializeModel(options?: ModelInitOptions): Promise<ResolvedModel> {
  const tenantId = modelTenantContext(options?.tenantId);
  const resolveOptions = { ...options, ...(tenantId ? { tenantId } : {}) };
  const provider = detectConfiguredProvider(resolveOptions);
  if (
    provider !== "mock" &&
    (provider === "unconfigured" ||
      modelKeyOwner(provider, tenantId, options?.apiKeyOverride) !== "workspace")
  ) {
    await assertOperatorKeyAllowed(tenantId, options?.exec);
  }
  return resolveModel(resolveOptions);
}
