import { expect, test } from "bun:test";
import type { LlmCacheReported, LlmGroup } from "../stats/index.ts";
import { promptCacheByFlow } from "./operating-figures.ts";

function group(flow: string, calls: number, prompt: number, cacheRead: number): LlmGroup {
  const latency = { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    key: { flow },
    buckets: [],
    totals: {
      calls,
      tokens: { prompt, completion: 0, cache_read: cacheRead, cache_creation: 0, total: prompt },
      latency_ms: latency,
      result: { success: calls },
    },
  };
}

function reported(
  entries: Record<string, LlmCacheReported>,
): ReadonlyMap<string, LlmCacheReported> {
  return new Map(Object.entries(entries));
}

test("each flow reports the share of its prompt tokens read from the cache", () => {
  const flows = promptCacheByFlow(
    [group("generate", 180, 720_000, 0), group("converse", 943, 71_668_000, 55_637_000)],
    reported({
      generate: { calls: 180, prompt: 720_000, cache_read: 0 },
      converse: { calls: 943, prompt: 71_668_000, cache_read: 55_637_000 },
    }),
  );
  expect(flows).toEqual([
    {
      flow: "converse",
      calls: 943,
      prompt_tokens: 71_668_000,
      cache_read_tokens: 55_637_000,
      cache_read_percent: 78,
    },
    {
      flow: "generate",
      calls: 180,
      prompt_tokens: 720_000,
      cache_read_tokens: 0,
      cache_read_percent: 0,
    },
  ]);
});

test("a flow without prompt tokens has no share and calls-free flows are left out", () => {
  const flows = promptCacheByFlow(
    [group("embed", 4, 0, 0), group("classify", 0, 0, 0)],
    reported({ embed: { calls: 4, prompt: 0, cache_read: 0 } }),
  );
  expect(flows).toEqual([
    { flow: "embed", calls: 4, prompt_tokens: 0, cache_read_tokens: 0, cache_read_percent: null },
  ]);
});

test("the share never exceeds the prompt tokens", () => {
  const [flow] = promptCacheByFlow(
    [group("converse", 1, 100, 140)],
    reported({ converse: { calls: 1, prompt: 100, cache_read: 140 } }),
  );
  expect(flow?.cache_read_percent).toBe(100);
});

test("a flow whose provider never reported cache figures has no share, not 0", () => {
  const flows = promptCacheByFlow([group("workflow_step", 3, 9_000, 0)], reported({}));
  expect(flows).toEqual([
    {
      flow: "workflow_step",
      calls: 3,
      prompt_tokens: 9_000,
      cache_read_tokens: 0,
      cache_read_percent: null,
    },
  ]);
});

test("the share counts only the prompt tokens of calls that reported cache figures", () => {
  const [flow] = promptCacheByFlow(
    [group("workflow_step", 3, 4_000, 300)],
    reported({ workflow_step: { calls: 1, prompt: 1_000, cache_read: 300 } }),
  );
  expect(flow?.cache_read_percent).toBe(30);
});
