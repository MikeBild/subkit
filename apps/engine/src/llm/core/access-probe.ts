import { APICallError, generateText } from "ai";
import { getConfig } from "../../config/loader.ts";
import { DEFAULT_MODELS, defaultModelFor, modelFamilyMismatch } from "../model-catalog-view.ts";
import { classifyProviderError } from "../provider-errors.ts";
import {
  configuredProviderModel,
  type DirectProviderKind,
  enforcesModelFamily,
  initializeModel,
  ProviderMisconfiguredError,
} from "./model-init.ts";

export type LlmAccessProvider = "mock" | DirectProviderKind;

export type LlmAccessResult =
  | { ok: true; model: string | null }
  | { ok: false; model: string | null; reason: string };

export interface LlmAccessRequest {
  provider: LlmAccessProvider;
  api_key: string;
  model?: string;
}

export type LlmAccessProbe = (p: LlmAccessRequest) => Promise<LlmAccessResult>;

const NON_CATALOG_PROBE_MODELS: Partial<Record<DirectProviderKind, string>> = {
  vertex: DEFAULT_MODELS.gemini.light,
};

export const LLM_PROBE_TIMEOUT_MS = 20_000;

function primaryModelFor(provider: DirectProviderKind): string | undefined {
  try {
    const llm = getConfig().llm;
    if (llm.provider !== provider || !llm.model) return undefined;
    return enforcesModelFamily(provider) && modelFamilyMismatch(provider, llm.model)
      ? undefined
      : llm.model;
  } catch {
    return undefined;
  }
}

export function probeModel(provider: DirectProviderKind, requested?: string): string | undefined {
  return (
    requested?.trim() ||
    configuredProviderModel(provider) ||
    primaryModelFor(provider) ||
    defaultModelFor(provider, "light") ||
    NON_CATALOG_PROBE_MODELS[provider]
  );
}

function missingSetting(provider: DirectProviderKind, setting: string | null): string {
  return setting
    ? `${provider} needs ${setting} in the engine environment before the first start; set it and run sk init again`
    : `${provider} is not fully configured in the engine environment; set its settings and run sk init again`;
}

function statusOf(err: unknown): number | null {
  if (APICallError.isInstance(err)) return err.statusCode ?? null;
  const status = (err as { statusCode?: unknown; status?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : null;
}

export function probeVerdict(
  err: unknown,
  provider: DirectProviderKind,
  model: string,
  timeoutMs: number = LLM_PROBE_TIMEOUT_MS,
): LlmAccessResult {
  const status = statusOf(err);
  const kind = classifyProviderError(err);
  const fail = (reason: string): LlmAccessResult => ({ ok: false, model, reason });
  if (kind === "rate_limit") return { ok: true, model };
  if (status === 401 || status === 403) {
    return fail(`${provider} rejected the API key (HTTP ${status})`);
  }
  if (kind === "quota_exhausted") {
    return fail(`${provider} accepted the API key but has no quota or credit left`);
  }
  if (status === 404) return fail(`${provider} does not offer the model ${model} to this key`);
  if (status !== null && status >= 400 && status < 500) {
    return fail(`${provider} refused the probe request (HTTP ${status})`);
  }
  if (kind === "timeout" || (err instanceof Error && err.name === "TimeoutError")) {
    return fail(`${provider} did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
  }
  if (status !== null) return fail(`${provider} is not available right now (HTTP ${status})`);
  return fail(`${provider} could not be reached`);
}

export async function probeLlmAccess(
  p: LlmAccessRequest,
  deps: { timeoutMs?: number; generate?: typeof generateText } = {},
): Promise<LlmAccessResult> {
  if (p.provider === "mock") return { ok: true, model: null };
  const provider = p.provider;
  const model = probeModel(provider, p.model);
  if (!model) {
    return {
      ok: false,
      model: null,
      reason: `${provider} needs a model before the first start; pass it with sk init --llm-model <${provider === "azure" ? "deployment name" : "model id"}>`,
    };
  }
  const timeoutMs = deps.timeoutMs ?? LLM_PROBE_TIMEOUT_MS;
  let resolved: Awaited<ReturnType<typeof initializeModel>>;
  try {
    resolved = await initializeModel({
      providerOverride: provider,
      apiKeyOverride: p.api_key,
      defaultModel: model,
      modelOverride: model,
    });
  } catch (err) {
    if (err instanceof ProviderMisconfiguredError) {
      return { ok: false, model, reason: missingSetting(provider, err.setting) };
    }
    throw err;
  }
  try {
    await (deps.generate ?? generateText)({
      model: resolved.model,
      prompt: "Reply with OK.",
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, model: resolved.modelId };
  } catch (err) {
    return probeVerdict(err, provider, resolved.modelId, timeoutMs);
  }
}
