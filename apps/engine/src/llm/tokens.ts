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
import type { LlmFlow, UserTurn } from "./types.ts";

let cached: Tiktoken | null = null;

function getEnc(): Tiktoken {
  if (cached) return cached;
  // cl100k_base is the best-supported preset in js-tiktoken and gives a
  // stable, deterministic count across environments.
  cached = getEncoding("cl100k_base");
  return cached;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return getEnc().encode(text).length;
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
 * Three trigger paths:
 *   - model id ends in `-1m` (explicit per-tenant pin)
 *   - env `LLM_CONTEXT_1M=1` (cluster-wide opt-in)
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
  if (process.env.LLM_CONTEXT_1M === "1") return true;
  return false;
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
  // Mock model cap — sized to fit the full pre-loaded agent-skill
  // bundle (turn-rhythm + chat-first + confirmation-discipline +
  // error-recovery-and-rbac + conversational-authoring + …) plus a
  // sample tenant snapshot, with a small headroom so genuine prompt
  // overflow still surfaces. Pre-bump this was 8_000, which fit the
  // older agent-skill bundle but not the current reference-aligned
  // version (Build Recipe + 5-failure cap + structured recovery
  // rules). Bumping to 12_000 keeps overflow detection alive while
  // matching the bundled rules' real footprint.
  if (id.includes("mock")) return 12_000;
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
