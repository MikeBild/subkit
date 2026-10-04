import { getConfig } from "../../config/loader.ts";
import type { RequestStep } from "../../workflows/types.ts";

const CHARS_PER_TOKEN = 4;

const PROMPT_FLOOR_TOKENS = 50;

const LLM_PROVIDER_HOSTS = new Set<string>([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "gateway.ai.cloudflare.com",
  "ai-gateway.vercel.sh",
]);

function extraHosts(): Set<string> {
  const merged: string[] = [];
  try {
    const list = getConfig().egress.provider_hosts_extra ?? [];
    merged.push(...list);
  } catch {}
  return new Set(merged.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0));
}

export class LlmBudgetExceededError extends Error {
  readonly code = "llm_budget_exceeded";
  readonly running_total: number;
  readonly estimated_call_tokens: number;
  readonly cap: number;

  constructor(params: { running_total: number; estimated_call_tokens: number; cap: number }) {
    super(
      `per-run LLM token cap exceeded: running ${params.running_total} + estimated ${params.estimated_call_tokens} > cap ${params.cap}`,
    );
    this.name = "LlmBudgetExceededError";
    this.running_total = params.running_total;
    this.estimated_call_tokens = params.estimated_call_tokens;
    this.cap = params.cap;
  }
}

export interface LlmCallUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export class RunLlmBudget {
  private running = 0;
  constructor(readonly cap: number | null) {}

  get total(): number {
    return this.running;
  }

  checkPreCall(estimated_call_tokens: number): void {
    if (this.cap == null) return;
    if (this.running + estimated_call_tokens > this.cap) {
      throw new LlmBudgetExceededError({
        running_total: this.running,
        estimated_call_tokens,
        cap: this.cap,
      });
    }
  }

  account(usage: LlmCallUsage): void {
    this.running += Math.max(0, usage.total_tokens);
  }
}

export function isLlmProviderUrl(url: string | URL | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    const host = u.hostname.toLowerCase();
    if (LLM_PROVIDER_HOSTS.has(host)) return true;
    return extraHosts().has(host);
  } catch {
    return false;
  }
}

export function stepLooksLikeLlmCall(step: RequestStep): boolean {
  if (step.url && isLlmProviderUrl(step.url)) return true;
  return false;
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
  const fromBody = Math.ceil(chars / CHARS_PER_TOKEN);
  return Math.max(PROMPT_FLOOR_TOKENS, fromBody);
}

export function parseLlmUsage(body: unknown): LlmCallUsage | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const usage = root.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  const promptChat = numberish(u.prompt_tokens);
  const completionChat = numberish(u.completion_tokens);
  if (promptChat !== null || completionChat !== null) {
    const prompt = promptChat ?? 0;
    const completion = completionChat ?? 0;
    const details = asRecord(u.prompt_tokens_details);
    const cacheRead = numberish(details?.cached_tokens) ?? 0;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: numberish(u.total_tokens) ?? prompt + completion,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: numberish(details?.cache_write_tokens) ?? 0,
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
  };
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
