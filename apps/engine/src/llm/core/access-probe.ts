import { APICallError, generateText } from "ai";
import { getConfig } from "../../config/loader.ts";
import { classifyProviderError } from "../provider-errors.ts";
import {
  type DirectProviderKind,
  initializeModel,
  ProviderMisconfiguredError,
} from "./model-init.ts";

export type LlmAccessProvider = "mock" | DirectProviderKind;

export type LlmAccessResult =
  | { ok: true; model: string | null }
  | { ok: false; model: string | null; reason: string };

export type LlmAccessProbe = (p: {
  provider: LlmAccessProvider;
  api_key: string;
}) => Promise<LlmAccessResult>;

const PROBE_MODELS: Partial<Record<DirectProviderKind, string>> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  vertex: "gemini-2.5-flash",
};

export const LLM_PROBE_TIMEOUT_MS = 20_000;

function configuredModel(): string | undefined {
  try {
    return getConfig().llm.model || undefined;
  } catch {
    return undefined;
  }
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
  p: { provider: LlmAccessProvider; api_key: string },
  deps: { timeoutMs?: number; generate?: typeof generateText } = {},
): Promise<LlmAccessResult> {
  if (p.provider === "mock") return { ok: true, model: null };
  const provider = p.provider;
  const defaultModel = configuredModel() ?? PROBE_MODELS[provider];
  if (!defaultModel) {
    return {
      ok: false,
      model: null,
      reason: `${provider} needs its model or deployment configured (llm.model) before the first start`,
    };
  }
  const timeoutMs = deps.timeoutMs ?? LLM_PROBE_TIMEOUT_MS;
  let resolved: Awaited<ReturnType<typeof initializeModel>>;
  try {
    resolved = await initializeModel({
      providerOverride: provider,
      apiKeyOverride: p.api_key,
      defaultModel,
    });
  } catch (err) {
    if (err instanceof ProviderMisconfiguredError) {
      return { ok: false, model: defaultModel, reason: err.message };
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
