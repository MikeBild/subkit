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
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

export function writeDryRunCache(key: string, result: RunResult): void {
  if (result.status !== "succeeded") return;
  if (cache.size >= MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { key, result, expiresAt: Date.now() + TTL_MS });
}

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

export function isStepKindCacheable(stepKind: unknown, stepConfig: unknown): boolean {
  if (typeof stepKind !== "string") return false;
  if (stepKind === "transform") return true;
  if (stepKind === "request") {
    const method = (stepConfig as { method?: unknown } | null)?.method;
    if (typeof method !== "string") return true;
    return method.toUpperCase() === "GET";
  }
  if (stepKind === "graphql") {
    const operation = (stepConfig as { operation?: unknown } | null)?.operation;
    return typeof operation === "string" && operation.toLowerCase() === "query";
  }
  return false;
}

export function __resetDryRunCacheForTest(): void {
  cache.clear();
  stepCache.clear();
}
