// Process-level cache for dry_run_workflow results.
//
// Pre-fix the LLM author re-previewed the same draft across many
// turns — session f00b8d1c hit api.digitalocean.com 109 times for what
// was fundamentally the same first 4 fetches repeated across ~15 dry
// runs. Each dry run replays every step end-to-end, even when only a
// downstream transform changed, because the engine has no notion of
// "skip steps whose config did not change since last run."
//
// This cache is the cheap-first cut: hash the entire draft + input
// together; if the hash matches a recent successful run we return the
// cached RunResult-shape envelope so the LLM sees the same output
// without spending another upstream call. A miss goes through to the
// engine as normal.
//
// Scope: process-local LRU keyed by `(tenant_id, env, draft_hash,
// input_hash)`. Cache lives ≤ 5 min. Multi-instance engines miss the
// shared-cache benefit; that is acceptable for the dev/authoring path
// (the only caller). Failed runs are NOT cached (the LLM almost
// always edits and retries; the second run shouldn't replay the
// failure).

import { createHash } from "node:crypto";
import type { ExecutionMode, RunResult } from "../../execution/types.ts";

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 256;

interface CacheEntry {
  key: string;
  result: RunResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
}

export function buildDryRunCacheKey(opts: {
  tenant_id: string;
  execution_mode: ExecutionMode;
  draft: unknown;
  input: unknown;
}): string {
  const payload = {
    tenant: opts.tenant_id,
    env: opts.execution_mode,
    draft: opts.draft,
    input: opts.input ?? null,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function readDryRunCache(key: string): RunResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU order — most-recently-read goes to the back of the map.
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

export function writeDryRunCache(key: string, result: RunResult): void {
  // Only cache fully-succeeded runs. A failure should re-run on the
  // next preview; the LLM almost certainly edits between failures.
  if (result.status !== "succeeded") return;
  if (cache.size >= MAX_ENTRIES) {
    // Drop the oldest (insertion order) entry.
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { key, result, expiresAt: Date.now() + TTL_MS });
}

/** Test helper — wipes the cache. Not exported through the public surface. */
export function __resetDryRunCacheForTest(): void {
  cache.clear();
}
