// Per-run LLM-token budget accounting.
//
// Distinct from the per-tenant monthly budget in `apps/engine/src/llm/budgets.ts`:
//   - monthly budget gates the tenant's aggregate usage across all runs
//     and persists to `llm_usage`; it covers calls issued by engine-internal
//     flows (generate / extract / repair / converse / discover).
//   - per-run budget gates a single execution's cumulative LLM-provider
//     spend so a runaway loop or a prompt-bloat regression in an AI-augmented
//     recipe cannot silently rack up four-figure bills before the monthly cap
//     trips. Lives only in memory for the lifetime of the run.
//
// The per-run accumulator wraps the workflow's HTTP request steps that
// target a known LLM-provider host. Token counts are extracted from the
// provider's response envelope (OpenAI: `usage.prompt_tokens` /
// `usage.completion_tokens`; Anthropic: `usage.input_tokens` /
// `usage.output_tokens`; both include `total_tokens` when the provider
// reports it).
//
// Pre-call check semantics:
//   - When `current + estimated_call_tokens > cap`, the executor refuses
//     to dispatch the call and surfaces `llm_budget_exceeded`.
//   - The estimate uses `Math.max(prompt_floor, request_body_chars / 4)`
//     so the floor is always honored even on a tiny first call. A real
//     LLM call almost always emits a non-trivial completion, so a small
//     floor (256 tokens) guards against a "fits exactly under the cap
//     pre-call but overruns post-call" hole.

import { getConfig } from "../../config/loader.ts";
import type { RequestStep } from "../../workflows/types.ts";

/** Approximate tokens per character. Tighter than 1/4 for ASCII English
 *  prose and looser for non-ASCII; budgets are hints, not metering. */
const CHARS_PER_TOKEN = 4;

/** Minimum estimated tokens for any single LLM call. Prevents a
 *  zero-body call from being waved through under a hard cap. Kept
 *  modest so a tiny prompt (e.g. an embedding lookup with a one-word
 *  query) still passes a low cap when the running total is well under;
 *  the post-call accounting is the authoritative ledger. */
const PROMPT_FLOOR_TOKENS = 50;

/** Hosts whose responses follow the OpenAI- or Anthropic-shaped
 *  `usage` envelope. Match by hostname (case-insensitive); subdomains
 *  must match exactly to avoid false-positive accounting on
 *  customer-owned proxies that happen to embed a provider name in the
 *  path.
 *
 *  Test overrides: comma-separated `SUBKIT_LLM_PROVIDER_HOSTS_EXTRA`
 *  appends additional hosts (e.g. `127.0.0.1` for an in-process mock
 *  server in integration tests). The variable is resolved on every
 *  call so tests can flip it per-suite. */
const LLM_PROVIDER_HOSTS = new Set<string>([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "gateway.ai.cloudflare.com",
  // AI Gateway (Vercel AI SDK) — proxies multiple providers behind one
  // host. Token usage is normalised in the response envelope.
  "ai-gateway.vercel.sh",
]);

function extraHosts(): Set<string> {
  try {
    const list = getConfig().egress.provider_hosts_extra ?? [];
    return new Set(
      list.map((s: string) => s.trim().toLowerCase()).filter((s: string) => s.length > 0),
    );
  } catch {
    return new Set();
  }
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
}

/** Per-run accumulator. One instance per `runExecution` invocation. */
export class RunLlmBudget {
  private running = 0;
  constructor(readonly cap: number | null) {}

  get total(): number {
    return this.running;
  }

  /** Pre-call gate. Throws `LlmBudgetExceededError` when the projected
   *  total would exceed the cap. No-op when `cap` is null. */
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

  /** Account a completed call's tokens. Always called after dispatch,
   *  regardless of whether the cap is set — operators rely on the
   *  `total_llm_tokens` audit field even on uncapped runs. */
  account(usage: LlmCallUsage): void {
    this.running += Math.max(0, usage.total_tokens);
  }
}

/** Hostname check. Case-insensitive; subdomains must match an exact
 *  entry in `LLM_PROVIDER_HOSTS` or in the test-only env override
 *  `SUBKIT_LLM_PROVIDER_HOSTS_EXTRA`. */
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

/** Heuristic for "this `request` step targets an LLM provider".
 *  Probes `step.url` first (raw HTTP path) and then any plausible
 *  hint embedded in the body — connector-routed steps need the
 *  resolved URL which only the dispatcher knows, so connector recipes
 *  rely on `isLlmProviderUrl` against the post-substitution URL once
 *  it's resolved. */
export function stepLooksLikeLlmCall(step: RequestStep): boolean {
  if (step.url && isLlmProviderUrl(step.url)) return true;
  return false;
}

/** Estimate the upper bound on the call's prompt tokens from the raw
 *  request body. Used by the pre-call gate when the actual usage is
 *  not yet known. Falls back to `PROMPT_FLOOR_TOKENS` when the body
 *  is empty or unmeasurable. */
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

/** Parse the `usage` envelope from an LLM provider response. Recognises
 *  the OpenAI-shaped `{ prompt_tokens, completion_tokens, total_tokens }`
 *  and the Anthropic-shaped `{ input_tokens, output_tokens }`. Returns
 *  `null` when the body has no recognisable usage block — the caller
 *  treats that as "no LLM-token cost recorded for this call". */
export function parseLlmUsage(body: unknown): LlmCallUsage | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const usage = root.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  // OpenAI shape — `prompt_tokens` + `completion_tokens` (+ `total_tokens`).
  const promptOpenai = numberish(u.prompt_tokens);
  const completionOpenai = numberish(u.completion_tokens);
  if (promptOpenai !== null || completionOpenai !== null) {
    const prompt = promptOpenai ?? 0;
    const completion = completionOpenai ?? 0;
    const total = numberish(u.total_tokens) ?? prompt + completion;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  }

  // Anthropic shape — `input_tokens` + `output_tokens`.
  const promptAnthropic = numberish(u.input_tokens);
  const completionAnthropic = numberish(u.output_tokens);
  if (promptAnthropic !== null || completionAnthropic !== null) {
    const prompt = promptAnthropic ?? 0;
    const completion = completionAnthropic ?? 0;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
  }
  return null;
}

function numberish(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
