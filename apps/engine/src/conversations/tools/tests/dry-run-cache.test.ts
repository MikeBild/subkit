import { afterEach, describe, expect, test } from "bun:test";
import type { RunResult } from "../../../execution/types.ts";
import {
  __resetDryRunCacheForTest,
  buildDryRunCacheKey,
  buildStepPrefixHash,
  isStepKindCacheable,
  readDryRunCache,
  readStepFixture,
  writeDryRunCache,
  writeStepFixture,
} from "../dry-run-cache.ts";

const sample: RunResult = {
  execution_id: "abc",
  status: "succeeded",
  output: { ok: true },
  error: null,
  steps: [],
};

afterEach(() => {
  __resetDryRunCacheForTest();
});

describe("dry-run cache", () => {
  test("hash is stable across key reordering of input objects", () => {
    const k1 = buildDryRunCacheKey({
      tenant_id: "t1",
      execution_mode: "dev",
      draft: { name: "x", steps: [{ id: "a", kind: "request" }] },
      input: { a: 1, b: 2 },
    });
    const k2 = buildDryRunCacheKey({
      tenant_id: "t1",
      execution_mode: "dev",
      draft: { name: "x", steps: [{ id: "a", kind: "request" }] },
      input: { b: 2, a: 1 },
    });
    expect(k1).toBe(k2);
  });

  test("different drafts hash differently", () => {
    const k1 = buildDryRunCacheKey({
      tenant_id: "t1",
      execution_mode: "dev",
      draft: { name: "x", steps: [{ id: "a", kind: "request" }] },
      input: null,
    });
    const k2 = buildDryRunCacheKey({
      tenant_id: "t1",
      execution_mode: "dev",
      draft: { name: "x", steps: [{ id: "b", kind: "request" }] },
      input: null,
    });
    expect(k1).not.toBe(k2);
  });

  test("write + read returns the cached result", () => {
    const key = "k1";
    expect(readDryRunCache(key)).toBeNull();
    writeDryRunCache(key, sample);
    expect(readDryRunCache(key)).toEqual(sample);
  });

  test("does not cache non-success runs", () => {
    const failed: RunResult = { ...sample, status: "failed" };
    writeDryRunCache("kf", failed);
    expect(readDryRunCache("kf")).toBeNull();
  });
});

describe("step prefix cache", () => {
  test("identical step-0 + different step-1 → same step-0 hash, different step-1 hash", () => {
    const tenant_id = "t1";
    const execution_mode = "dev" as const;
    const draftA = {
      name: "wf",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://example.com/users" },
        { id: "shape", kind: "transform", expression: "fetch.data.users" },
      ],
    };
    const draftB = {
      name: "wf",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://example.com/users" },
        { id: "shape", kind: "transform", expression: "fetch.data.users.name" },
      ],
    };
    const aStep0 = buildStepPrefixHash({
      tenant_id,
      execution_mode,
      draft: draftA,
      input: null,
      stepIndex: 0,
    });
    const bStep0 = buildStepPrefixHash({
      tenant_id,
      execution_mode,
      draft: draftB,
      input: null,
      stepIndex: 0,
    });
    const aStep1 = buildStepPrefixHash({
      tenant_id,
      execution_mode,
      draft: draftA,
      input: null,
      stepIndex: 1,
    });
    const bStep1 = buildStepPrefixHash({
      tenant_id,
      execution_mode,
      draft: draftB,
      input: null,
      stepIndex: 1,
    });
    expect(aStep0).toBe(bStep0);
    expect(aStep1).not.toBe(bStep1);
  });

  test("write + read returns the cached envelope", () => {
    const envelope = { data: { users: [{ id: 1 }] }, status_code: 200 };
    expect(readStepFixture("h1")).toBeNull();
    writeStepFixture("h1", envelope);
    expect(readStepFixture("h1")).toEqual(envelope);
  });

  test("isStepKindCacheable allows GET request, transform, query GraphQL — rejects others", () => {
    expect(isStepKindCacheable("transform", {})).toBe(true);
    expect(isStepKindCacheable("request", { method: "GET" })).toBe(true);
    expect(isStepKindCacheable("request", {})).toBe(true);
    expect(isStepKindCacheable("request", { method: "POST" })).toBe(false);
    expect(isStepKindCacheable("request", { method: "DELETE" })).toBe(false);
    expect(isStepKindCacheable("graphql", { operation: "query" })).toBe(true);
    expect(isStepKindCacheable("graphql", { operation: "mutation" })).toBe(false);
    expect(isStepKindCacheable("loop", {})).toBe(false);
    expect(isStepKindCacheable("call", {})).toBe(false);
  });
});
