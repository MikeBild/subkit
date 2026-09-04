// Cache-block splitter.
//
// Splits an assembled EnhancedPrompt into two blocks so the provider (via
// the Vercel AI Gateway or the underlying Anthropic provider) can cache the
// stable portion and re-compute only the volatile portion each turn:
//
//   stable   = base system + all Skills + ingested connector docs
//              (changes rarely → long TTL, high cache hit rate)
//   volatile = user memory + prior-failure traces + the volatile sections the
//              context assembler marks as such
//              (changes every turn → uncached)
//
// The split is purely textual. The provider registry (core/invoke.ts)
// decides how to apply the cache-hint based on the resolved model — the
// Anthropic direct provider gets `cacheControl: {type:"ephemeral", ttl:"1h"}`
// on the stable block; the Gateway passes it through when supported;
// providers that don't understand the hint ignore it.

import { countTokens } from "../accounting/index.ts";
import type { EnhancedPrompt, LlmFlow } from "../types.ts";

export interface CacheBlocks {
  /** Stable head — send with cache-hint. */
  stable: string;
  /** Volatile tail — send fresh every turn. */
  volatile: string;
  token_counts: {
    stable: number;
    volatile: number;
  };
}

// Section markers rendered by context.ts:formatSkill / formatChunk /
// formatKnowledgeChunk / formatFailure / formatUserMemory. We split on
// these so the heuristic stays deterministic.
const STABLE_HEAD_MARKERS = ["# Skill:", "## Doc:", "## Knowledge:"];
const VOLATILE_HEAD_MARKERS = ["# User memory", "## Prior failure:"];

export function splitPromptIntoBlocks(prompt: EnhancedPrompt, flow: LlmFlow): CacheBlocks {
  const stableParts: string[] = [];
  const volatileParts: string[] = [];

  if (prompt.system_sections && prompt.system_sections.length > 0) {
    // The assembler decided this where each section was built. Nothing to
    // re-derive, nothing to guess.
    for (const section of prompt.system_sections) {
      if (section.text.length === 0) continue;
      (section.volatile ? volatileParts : stableParts).push(section.text);
    }
  } else {
    // Fallback for prompts assembled elsewhere (one-shot callers and older
    // fixtures) that carry no section list.
    //
    // Note the polarity: unknown is VOLATILE here. The reverse — treating
    // anything unrecognised as stable — is what put per-turn blocks inside the
    // cached prefix, and an over-cautious split only costs a cache miss,
    // whereas an over-eager one silently pays full price for the whole prefix.
    for (const section of prompt.system.split("\n\n")) {
      if (section.length === 0) continue;
      const isVolatile = VOLATILE_HEAD_MARKERS.some((m) => section.startsWith(m));
      const isStable =
        !isVolatile &&
        (STABLE_HEAD_MARKERS.some((m) => section.startsWith(m)) || stableParts.length === 0);
      (isStable ? stableParts : volatileParts).push(section);
    }
  }

  // Repair flow: failures carry the whole reason we are repairing and
  // should drive the model's output; they sit at the end of volatile so
  // they appear after user memory in the rendered tail.
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
  /** Apply the hint? Callers gate this on `ModelRoute.enable_prompt_cache`. */
  enabled: boolean;
  /** 1h is the practical sweet spot for long-running authoring sessions. */
  ttl?: "5m" | "1h";
}

/**
 * Produce the system-message array shape the Vercel AI SDK expects,
 * with the cache-hint attached to the stable head when enabled. The
 * volatile tail is always a second, uncached system message.
 *
 * The cache hint uses the Anthropic provider-options slot. Through the
 * Vercel AI Gateway this passes through to providers that support it;
 * others ignore it safely.
 */
export function toSystemMessages(
  blocks: CacheBlocks,
  opts: CacheHintOptions,
): Array<{
  role: "system";
  content: string;
  providerOptions?: {
    anthropic: { cacheControl: { type: "ephemeral"; ttl: "5m" | "1h" } };
  };
}> {
  const out: Array<{
    role: "system";
    content: string;
    providerOptions?: {
      anthropic: { cacheControl: { type: "ephemeral"; ttl: "5m" | "1h" } };
    };
  }> = [];
  if (blocks.stable.length > 0) {
    const head: {
      role: "system";
      content: string;
      providerOptions?: {
        anthropic: { cacheControl: { type: "ephemeral"; ttl: "5m" | "1h" } };
      };
    } = { role: "system", content: blocks.stable };
    if (opts.enabled) {
      head.providerOptions = {
        anthropic: { cacheControl: { type: "ephemeral", ttl: opts.ttl ?? "1h" } },
      };
    }
    out.push(head);
  }
  if (blocks.volatile.length > 0) {
    out.push({ role: "system", content: blocks.volatile });
  }
  return out;
}
