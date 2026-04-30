// Unit tests for the conversation-scoped dry-run cache.

import { afterEach, describe, expect, test } from "bun:test";
import type { RunResult } from "../../../execution/types.ts";
import {
  __resetDryRunCacheForTest,
  buildDryRunCacheKey,
  readDryRunCache,
  writeDryRunCache,
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
