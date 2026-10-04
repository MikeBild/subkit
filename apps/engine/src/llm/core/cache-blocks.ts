import { countTokens } from "../accounting/index.ts";
import type { EnhancedPrompt, LlmFlow } from "../types.ts";

export const PROMPT_CACHE_TTL = "1h" as const;
export type PromptCacheTtl = typeof PROMPT_CACHE_TTL;

export interface CacheBlocks {
  stable: string;
  volatile: string;
  token_counts: {
    stable: number;
    volatile: number;
  };
}

const STABLE_HEAD_MARKERS = ["# Skill:", "## Doc:", "## Knowledge:"];
const VOLATILE_HEAD_MARKERS = ["# User memory", "## Prior failure:"];

export function splitPromptIntoBlocks(prompt: EnhancedPrompt, flow: LlmFlow): CacheBlocks {
  const stableParts: string[] = [];
  const volatileParts: string[] = [];

  if (prompt.system_sections && prompt.system_sections.length > 0) {
    for (const section of prompt.system_sections) {
      if (section.text.length === 0) continue;
      (section.volatile ? volatileParts : stableParts).push(section.text);
    }
  } else {
    for (const section of prompt.system.split("\n\n")) {
      if (section.length === 0) continue;
      const isVolatile = VOLATILE_HEAD_MARKERS.some((m) => section.startsWith(m));
      const isStable =
        !isVolatile &&
        (STABLE_HEAD_MARKERS.some((m) => section.startsWith(m)) || stableParts.length === 0);
      (isStable ? stableParts : volatileParts).push(section);
    }
  }

  void flow;

  const stable = stableParts.join("\n\n");
  const volatile = volatileParts.join("\n\n");
  return {
    stable,
    volatile,
    token_counts: {
      stable: countTokens(stable),
      volatile: countTokens(volatile),
    },
  };
}

export interface CacheHintOptions {
  enabled: boolean;
  ttl?: PromptCacheTtl;
}

export function toSystemMessages(
  blocks: CacheBlocks,
  opts: CacheHintOptions,
): Array<{
  role: "system";
  content: string;
  providerOptions?: {
    anthropic: { cacheControl: { type: "ephemeral"; ttl: PromptCacheTtl } };
  };
}> {
  const out: Array<{
    role: "system";
    content: string;
    providerOptions?: {
      anthropic: { cacheControl: { type: "ephemeral"; ttl: PromptCacheTtl } };
    };
  }> = [];
  if (blocks.stable.length > 0) {
    const head: {
      role: "system";
      content: string;
      providerOptions?: {
        anthropic: { cacheControl: { type: "ephemeral"; ttl: PromptCacheTtl } };
      };
    } = { role: "system", content: blocks.stable };
    if (opts.enabled) {
      head.providerOptions = {
        anthropic: { cacheControl: { type: "ephemeral", ttl: opts.ttl ?? PROMPT_CACHE_TTL } },
      };
    }
    out.push(head);
  }
  if (blocks.volatile.length > 0) {
    out.push({ role: "system", content: blocks.volatile });
  }
  return out;
}
