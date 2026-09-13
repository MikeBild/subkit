// Process-level cache for dry_run_workflow results.
//
// Pre-fix the LLM author re-previewed the same draft across many
// turns — session f00b8d1c hit api.digitalocean.com 109 times for what
// was fundamentally the same first 4 fetches repeated across ~15 dry
// runs. Each dry run replays every step end-to-end, even when only a
// downstream transform changed, because the engine had no notion of
// "skip steps whose config did not change since last run."
//
// Two layers:
//
//  1. **Whole-draft cache** (`buildDryRunCacheKey` /
//     `readDryRunCache` / `writeDryRunCache`) — hash the entire draft
//     + input; if the hash matches a recent succeeded run we return
//     the cached RunResult envelope so the LLM sees the same output
//     without spending another upstream call. A miss goes through to
//     the engine. Cheap path for repeated identical previews.
//
//  2. **Per-step prefix cache** (`buildStepPrefixHash` /
//     `readStepFixture` / `writeStepFixture`) — for each step, hash
//     the *prefix* of the draft up to and including that step, plus
//     the input. After a successful run, every safe-to-cache step's
//     envelope is stored under its prefix hash. On the next preview
//     the dry-run loop walks the draft from the top: while the prefix
//     hash hits, the engine replays the cached envelope via
//     `RunOptions.step_output_fixtures`; the first miss starts real
//     execution. This is what makes "edit only the transform → no
//     Jira fetch" work in session fb930dcb's authoring loop.
//
// Scope: process-local LRU. Cache lives ≤ 5 min. Multi-instance
// engines miss the shared-cache benefit; that is acceptable for the
// dev/authoring path (the only caller). The whole-draft layer only
// caches succeeded runs; the per-step layer caches successful steps
// regardless of the overall run status, so a failure downstream of a
// successful fetch still leaves the fetch's fixture warm for the next
// iteration.

import { createHash } from "node:crypto";

import type { ExecutionMode, RunResult } from "../../execution/types.ts";

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 256;
const MAX_STEP_ENTRIES = 1024;

interface CacheEntry {
  key: string;
  result: RunResult;
  expiresAt: number;
}

interface StepFixtureEntry {
  key: string;
  envelope: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const stepCache = new Map<string, StepFixtureEntry>();

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

/**
 * Hash the prefix of a draft up to (and including) the step at
 * `stepIndex`, plus the input. Two drafts that share step 0..i and
 * differ only in step i+1+ yield the same prefix hash at index i.
 * Used by the step-level fixture cache so editing a downstream
 * transform still hits the upstream's cached envelope.
 */
export function buildStepPrefixHash(opts: {
  tenant_id: string;
  execution_mode: ExecutionMode;
  draft: { steps: unknown[]; name?: string };
  input: unknown;
  stepIndex: number;
}): string {
  const prefixSteps = opts.draft.steps.slice(0, opts.stepIndex + 1);
  const payload = {
    tenant: opts.tenant_id,
    env: opts.execution_mode,
    name: opts.draft.name ?? null,
    prefix: prefixSteps,
    input: opts.input ?? null,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function readStepFixture(prefixHash: string): unknown | null {
  const entry = stepCache.get(prefixHash);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    stepCache.delete(prefixHash);
    return null;
  }
  // LRU refresh.
  stepCache.delete(prefixHash);
  stepCache.set(prefixHash, entry);
  return entry.envelope;
}

export function writeStepFixture(prefixHash: string, envelope: unknown): void {
  if (envelope === undefined || envelope === null) return;
  if (stepCache.size >= MAX_STEP_ENTRIES) {
    const first = stepCache.keys().next().value;
    if (first !== undefined) stepCache.delete(first);
  }
  stepCache.set(prefixHash, {
    key: prefixHash,
    envelope,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Identify step kinds that are safe to replay from a fixture without
 * re-executing. Conservative: any step that might write upstream
 * state, mint a token, or otherwise have side effects is excluded.
 * Callers wanting to extend this list should think about idempotency
 * first.
 */
export function isStepKindCacheable(stepKind: unknown, stepConfig: unknown): boolean {
  if (typeof stepKind !== "string") return false;
  if (stepKind === "transform") return true;
  if (stepKind === "request") {
    const method = (stepConfig as { method?: unknown } | null)?.method;
    if (typeof method !== "string") return true; // engine default is GET
    return method.toUpperCase() === "GET";
  }
  if (stepKind === "graphql") {
    // GraphQL drivers in subkit execute both queries and mutations;
    // we can only assume safety for explicit queries.
    const operation = (stepConfig as { operation?: unknown } | null)?.operation;
    return typeof operation === "string" && operation.toLowerCase() === "query";
  }
  return false;
}

/** Test helper — wipes the cache. Not exported through the public surface. */
export function __resetDryRunCacheForTest(): void {
  cache.clear();
  stepCache.clear();
}
