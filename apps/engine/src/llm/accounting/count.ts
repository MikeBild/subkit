// Token counting wrapper around js-tiktoken.
//
// The real Anthropic provider does not expose a client-side tokenizer, so
// we approximate with the closest OpenAI cl100k / o200k encoding. The
// approximation overcounts a little, which is the safe direction — our
// budget check trips early rather than late.
//
// The encoding instance is lazily constructed and cached per-process.

import type { ModelMessage } from "ai";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { getConfig } from "../../config/loader.ts";
import type { LlmFlow, UserTurn } from "../types.ts";

let cached: Tiktoken | null = null;

function getEnc(): Tiktoken {
  if (cached) return cached;
  // cl100k_base is the best-supported preset in js-tiktoken and gives a
  // stable, deterministic count across environments.
  cached = getEncoding("cl100k_base");
  return cached;
}

// ---------------------------------------------------------------------------
// Hot-path protection. js-tiktoken's BPE is pure JS and runs ON THE EVENT
// LOOP — production profiling correlated the engine's event_loop.lag warnings
// (median ~1.6s, RSS spikes of several hundred MB) with the per-model-call
// token counting in cache-blocks.ts (the full stable+volatile prompt) and
// countModelMessagesTokens (the full history, recounted EVERY step).
//
// Two mitigations, both count-preserving where it matters:
//  1. Memoize per-string counts KEYED BY A 64-BIT HASH, never the string.
//     The first version of this cache keyed by the string itself — that
//     pinned up to 4096 history/prompt strings (~700MB of malloc'd string
//     memory, confirmed by step.memory brackets in production) and traded
//     the BPE compute pauses for GC pauses over the pinned set. A wyhash
//     key retains 16 bytes per entry instead of the string. Collisions at
//     4096 entries over a 64-bit space are ~5e-13 — and a collision only
//     mis-counts an ADVISORY budget, never corrupts data.
//  2. Estimate above a size threshold. A single >64KB block costs hundreds
//     of ms to BPE-encode even once; budgets only need to know "how close to
//     the cap are we", so a chars/3.5 estimate (deliberately OVERcounting —
//     the budget trips early, never late) replaces the exact count there.
//     Estimates are O(1) and are NOT cached — no reason to spend entries
//     on them. The threshold is far above every budget-baseline fixture,
//     so pinned test counts are unaffected.
// ---------------------------------------------------------------------------
const COUNT_CACHE_LIMIT = 4096;
const countCache = new Map<bigint, number>();
const ESTIMATE_THRESHOLD_CHARS = 65_536;
// JSON-ish content runs ~3.5-4 chars/token; /3.5 leans high on purpose.
const ESTIMATE_CHARS_PER_TOKEN = 3.5;

/** 64-bit content hash. Bun.hash (wyhash, native, ~GB/s) when available;
 *  FNV-1a fallback keeps the module portable to plain-node tooling. */
function contentKey(text: string): bigint {
  const bunHash = (globalThis as { Bun?: { hash?: (s: string) => number | bigint } }).Bun?.hash;
  if (bunHash) return BigInt(bunHash(text));
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

function remember(key: bigint, tokens: number): number {
  if (countCache.size >= COUNT_CACHE_LIMIT) {
    const oldest = countCache.keys().next().value;
    if (oldest !== undefined) countCache.delete(oldest);
  }
  countCache.set(key, tokens);
  return tokens;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  if (text.length > ESTIMATE_THRESHOLD_CHARS) {
    return Math.ceil(text.length / ESTIMATE_CHARS_PER_TOKEN);
  }
  const key = contentKey(text);
  const hit = countCache.get(key);
  if (hit !== undefined) return hit;
  return remember(key, getEnc().encode(text).length);
}

export function countMessagesTokens(messages: UserTurn[]): number {
  // ChatML-ish framing overhead: 4 tokens per message + 2 for reply prime.
  let total = 2;
  for (const m of messages) {
    total += 4 + countTokens(m.content);
  }
  return total;
}

function modelMessageContentToText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  try {
    return JSON.stringify(message.content);
  } catch {
    return String(message.content);
  }
}

export function countModelMessagesTokens(messages: ModelMessage[]): number {
  let total = 2;
  for (const message of messages) {
    total += 4 + countTokens(modelMessageContentToText(message));
  }
  return total;
}

/**
 * Anthropic 1M-context-beta opt-in. The header is already attached in
 * `llm/core/model-init.ts:resolveAnthropic`, so the provider sends
 * `anthropic-beta: context-1m-2025-08-07` on every Claude call. The cap
 * here just lifts the *prompt budget* the assembler is allowed to fill.
 *
 * Two trigger paths:
 *   - model id ends in `-1m` (explicit per-tenant pin)
 *   - `llm.context_1m` in canonical runtime configuration
 *
 * When active, usable cap is 900k (1M window minus ~100k completion
 * buffer). Eviction logic in `context-assembler.ts` still runs — it just
 * has 5x more headroom before it kicks in. That keeps cache warmth and
 * cost-per-token sane for tenants that don't actually need the extra
 * room while unblocking large-skill / many-connector flows that did.
 */
const CLAUDE_1M_USABLE = 900_000;
const CLAUDE_DEFAULT_USABLE = 180_000;

function isClaudeId(id: string): boolean {
  return id.includes("sonnet") || id.includes("opus") || id.includes("haiku");
}

function isOneMillionContextActive(id: string): boolean {
  if (id.endsWith("-1m") || id.endsWith("-1m-2025-08-07")) return true;
  try {
    if (getConfig().llm.context_1m) return true;
  } catch {
    /* loader not initialised */
  }
  return false;
}

/**
 * The bare model id — the last path segment of a routing-style /-namespaced
 * id (e.g. `together/llama-3.3-70b` → `llama-3.3-70b`), otherwise the id as
 * given. Used to anchor family prefix matching so a vendor namespace can't
 * shift which prefix a `startsWith` check sees.
 */
function bareModelId(id: string): string {
  return id.includes("/") ? (id.split("/").pop() ?? id) : id;
}

/** Default effective context cap for a given model id. Conservative. */
export function contextCapFor(model: string): number {
  // These are the usable-for-prompt caps per Anthropic/OpenAI. A 200k
  // window minus a reasonable completion buffer lands around 180k.
  const id = model.toLowerCase();
  if (isClaudeId(id)) {
    return isOneMillionContextActive(id) ? CLAUDE_1M_USABLE : CLAUDE_DEFAULT_USABLE;
  }
  if (id.includes("gpt-4o")) return 120_000;
  if (id.includes("gpt-4")) return 110_000;
  if (id.includes("gpt-3.5")) return 15_000;
  // Common open-weight / OpenAI-compatible families. Without these, such a
  // model on the openai slot would fall to the 100k default below and
  // truncate under its real window. Anchored on the bare (last-segment) id
  // with `startsWith` so a merge id like `llama-mixtral-…` resolves to its
  // leading family instead of colliding into `mixtral`; ids that don't begin
  // with a known family token fall through to the conservative default.
  // Values are deliberately conservative usable caps (128k-class → ~120k):
  // under-fill is the safe direction — the budget trips early rather than
  // overrunning the provider, and family names alone can't distinguish a
  // long-context SKU from a small one (a per-endpoint window override is the
  // proper lever for that; tracked as a follow-up). This family list mirrors
  // `inferProvider` in `accountant.ts` — keep the two in lockstep.
  const bare = bareModelId(id);
  if (bare.startsWith("qwen")) return 120_000;
  if (bare.startsWith("glm")) return 120_000;
  if (bare.startsWith("deepseek")) return 120_000;
  if (bare.startsWith("ministral") || bare.startsWith("mistral") || bare.startsWith("mixtral"))
    return 110_000;
  if (bare.startsWith("gpt-oss")) return 120_000;
  if (bare.startsWith("llama")) return 120_000;
  // Mock model cap — sized to fit the full pre-loaded agent-skill
  // bundle (turn-rhythm + chat-first + confirmation-discipline +
  // error-recovery-and-rbac + conversational-authoring + …) plus a
  // sample tenant snapshot, with a small headroom so genuine prompt
  // overflow still surfaces. It is recalibrated whenever the bundle
  // grows: at 8_000 it fit the pre-reference-aligned rules, at 12_000
  // the Build Recipe + 5-failure cap + structured recovery rules, and
  // the workflow-authoring persona's irreducible prompt has since
  // reached ~12.2k, which left the knob with no headroom at all — any
  // added contract rule then failed the drop-ladder tests instead of
  // the size guard that exists for it. The real size regression net is
  // the budget-baseline fixture (G1-G3), not this number.
  if (id.includes("mock")) return 13_000;
  // Sane default for unknown models — Anthropic-ish.
  return 100_000;
}

/** Rough prompt-tokens estimate for a freshly composed prompt. */
export function estimatePromptTokens(args: { system: string; messages: UserTurn[] }): number {
  return countTokens(args.system) + countMessagesTokens(args.messages);
}

/** Pick a completion-side budget appropriate for the flow. */
export function completionBudgetFor(flow: LlmFlow): number {
  switch (flow) {
    case "generate":
      return 2_000;
    case "extract":
      return 4_000;
    case "repair":
      return 1_200;
    // The preview judge emits one small verdict object ({verdict,
    // reason, missing}) — budgeted like "repair", the other bounded
    // single-shot authoring-support flow.
    case "judge":
      return 1_200;
    case "converse":
      return 2_000;
    case "discover":
      return 4_000;
    case "summarize":
      return 512;
    default:
      return 1_500;
  }
}
