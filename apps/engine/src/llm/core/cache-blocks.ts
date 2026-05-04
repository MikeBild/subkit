// Cache-block splitter.
//
// Splits an assembled EnhancedPrompt into two blocks so the provider (via
// the Vercel AI Gateway or the underlying Anthropic provider) can cache the
// stable portion and re-compute only the volatile portion each turn:
//
//   stable   = base system + all Skills + ingested connector docs
//              (changes rarely → long TTL, high cache hit rate)
//   volatile = user memory + prior-failure traces + any [TENANT STATE]
//              / [RBAC SNAPSHOT] pseudo-messages
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
  // Base system prompt lives at the top of `prompt.system` and ends at the
  // first section break (empty line followed by a stable/volatile header).
  const sections = prompt.system.split("\n\n");

  const stableParts: string[] = [];
  const volatileParts: string[] = [];

  for (const section of sections) {
    if (section.length === 0) continue;
    const isVolatile = VOLATILE_HEAD_MARKERS.some((m) => section.startsWith(m));
    const isStable = STABLE_HEAD_MARKERS.some((m) => section.startsWith(m));
    if (isVolatile) {
      volatileParts.push(section);
    } else if (isStable) {
      stableParts.push(section);
    } else {
      // Base system prompt — attach to stable so the cache-hint covers the
      // flow's instruction set (rarely changes per-tenant).
      stableParts.push(section);
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
