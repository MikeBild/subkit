import type { ModelMessage } from "ai";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { getConfig } from "../../config/loader.ts";
import type { LlmFlow, UserTurn } from "../types.ts";

let cached: Tiktoken | null = null;

function getEnc(): Tiktoken {
  if (cached) return cached;
  cached = getEncoding("cl100k_base");
  return cached;
}

const COUNT_CACHE_LIMIT = 4096;
const countCache = new Map<bigint, number>();
const ESTIMATE_THRESHOLD_CHARS = 65_536;
const ESTIMATE_CHARS_PER_TOKEN = 3.5;

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

const CLAUDE_1M_USABLE = 900_000;
const CLAUDE_DEFAULT_USABLE = 180_000;
const MILLION_TOKEN_USABLE = 900_000;
const GPT5_USABLE = 360_000;

function isClaudeId(id: string): boolean {
  return (
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("haiku") ||
    bareModelId(id).startsWith("claude-")
  );
}

function isOneMillionContextActive(id: string): boolean {
  if (id.endsWith("-1m") || id.endsWith("-1m-2025-08-07")) return true;
  try {
    if (getConfig().llm.context_1m) return true;
  } catch {}
  return false;
}

function bareModelId(id: string): string {
  return id.includes("/") ? (id.split("/").pop() ?? id) : id;
}

export function contextCapFor(model: string): number {
  const id = model.toLowerCase();
  if (isClaudeId(id)) {
    return isOneMillionContextActive(id) ? CLAUDE_1M_USABLE : CLAUDE_DEFAULT_USABLE;
  }
  if (id.includes("gpt-4.1")) return MILLION_TOKEN_USABLE;
  if (id.includes("gpt-5")) return GPT5_USABLE;
  if (bareModelId(id).startsWith("gemini-")) return MILLION_TOKEN_USABLE;
  if (id.includes("gpt-4o")) return 120_000;
  if (id.includes("gpt-4")) return 110_000;
  if (id.includes("gpt-3.5")) return 15_000;
  const bare = bareModelId(id);
  if (bare.startsWith("qwen")) return 120_000;
  if (bare.startsWith("glm")) return 120_000;
  if (bare.startsWith("deepseek")) return 120_000;
  if (bare.startsWith("ministral") || bare.startsWith("mistral") || bare.startsWith("mixtral"))
    return 110_000;
  if (bare.startsWith("gpt-oss")) return 120_000;
  if (bare.startsWith("llama")) return 120_000;
  if (id.includes("mock")) return 13_000;
  return 100_000;
}

export function estimatePromptTokens(args: { system: string; messages: UserTurn[] }): number {
  return countTokens(args.system) + countMessagesTokens(args.messages);
}

export function completionBudgetFor(flow: LlmFlow): number {
  switch (flow) {
    case "generate":
      return 2_000;
    case "extract":
      return 4_000;
    case "catalog_describe":
      return 512;
    case "repair":
      return 1_200;
    case "judge":
      return 1_200;
    case "personal_notes":
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
