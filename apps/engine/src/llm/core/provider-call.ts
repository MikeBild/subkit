export interface LlmCallUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_reported: boolean;
}

const CHARS_PER_TOKEN = 4;

const PROMPT_FLOOR_TOKENS = 50;

const LLM_PROVIDER_HOSTS = new Set<string>([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "gateway.ai.cloudflare.com",
  "ai-gateway.vercel.sh",
]);

export function isLlmProviderHost(hostname: string, extraHosts: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase();
  if (host.length === 0) return false;
  if (LLM_PROVIDER_HOSTS.has(host)) return true;
  return extraHosts.some((extra) => extra.trim().toLowerCase() === host);
}

export function estimateLlmCallTokens(body: unknown): number {
  if (body === undefined || body === null) return PROMPT_FLOOR_TOKENS;
  let chars = 0;
  if (typeof body === "string") {
    chars = body.length;
  } else {
    try {
      chars = JSON.stringify(body).length;
    } catch {
      chars = 0;
    }
  }
  return Math.max(PROMPT_FLOOR_TOKENS, Math.ceil(chars / CHARS_PER_TOKEN));
}

function pickModelField(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const m = (v as Record<string, unknown>).model;
  return typeof m === "string" && m.length > 0 ? m : null;
}

export function extractModelHint(requestBody: unknown, responseBody: unknown): string {
  return pickModelField(requestBody) ?? pickModelField(responseBody) ?? "unknown";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numberish(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function parseLlmUsage(body: unknown): LlmCallUsage | null {
  const root = asRecord(body);
  const u = asRecord(root?.usage);
  if (!u) return null;

  const promptChat = numberish(u.prompt_tokens);
  const completionChat = numberish(u.completion_tokens);
  if (promptChat !== null || completionChat !== null) {
    const prompt = promptChat ?? 0;
    const completion = completionChat ?? 0;
    const details = asRecord(u.prompt_tokens_details);
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: numberish(u.total_tokens) ?? prompt + completion,
      cache_read_tokens: numberish(details?.cached_tokens) ?? 0,
      cache_creation_tokens: numberish(details?.cache_write_tokens) ?? 0,
      cache_reported: numberish(details?.cached_tokens) !== null,
    };
  }

  const inputTokens = numberish(u.input_tokens);
  const outputTokens = numberish(u.output_tokens);
  if (inputTokens === null && outputTokens === null) return null;
  const input = inputTokens ?? 0;
  const completion = outputTokens ?? 0;

  const responseDetails = asRecord(u.input_tokens_details);
  if (responseDetails) {
    return {
      prompt_tokens: input,
      completion_tokens: completion,
      total_tokens: numberish(u.total_tokens) ?? input + completion,
      cache_read_tokens: numberish(responseDetails.cached_tokens) ?? 0,
      cache_creation_tokens: numberish(responseDetails.cache_write_tokens) ?? 0,
      cache_reported: numberish(responseDetails.cached_tokens) !== null,
    };
  }

  const cacheRead = numberish(u.cache_read_input_tokens) ?? 0;
  const cacheCreate = numberish(u.cache_creation_input_tokens) ?? 0;
  const prompt = input + cacheRead + cacheCreate;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreate,
    cache_reported: numberish(u.cache_read_input_tokens) !== null,
  };
}
