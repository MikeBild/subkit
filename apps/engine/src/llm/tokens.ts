// Token counting wrapper around js-tiktoken.
//
// The real Anthropic provider does not expose a client-side tokenizer, so
// we approximate with the closest OpenAI cl100k / o200k encoding. The
// approximation overcounts a little, which is the safe direction — our
// budget check trips early rather than late.
//
// The encoding instance is lazily constructed and cached per-process.

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

/** Default effective context cap for a given model id. Conservative. */
export function contextCapFor(model: string): number {
  // These are the usable-for-prompt caps per Anthropic/OpenAI. A 200k
  // window minus a reasonable completion buffer lands around 180k.
  const id = model.toLowerCase();
  if (id.includes("sonnet")) return 180_000;
  if (id.includes("opus")) return 180_000;
  if (id.includes("haiku")) return 180_000;
  if (id.includes("gpt-4o")) return 120_000;
  if (id.includes("gpt-4")) return 110_000;
  if (id.includes("gpt-3.5")) return 15_000;
  if (id.includes("mock")) return 8_000;
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
    default:
      return 1_500;
  }
}
