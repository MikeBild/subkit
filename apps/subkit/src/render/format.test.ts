import { describe, expect, test } from "bun:test";
import { computeStepBottlenecks, executionDurationMs, formatTokens, humanMs } from "./format.ts";

describe("formatTokens", () => {
  test("renders en-dash for null/undefined", () => {
    expect(formatTokens(null)).toBe("–");
    expect(formatTokens(undefined)).toBe("–");
  });
  test("raw below 1k, k above, M above 1M", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(42_000)).toBe("42k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });
});

describe("humanMs", () => {
  test("scales ms → s → m → h", () => {
    expect(humanMs(840)).toBe("840ms");
    expect(humanMs(1_400)).toBe("1.4s");
    expect(humanMs(190_000)).toBe("3.2m");
    expect(humanMs(3_960_000)).toBe("1.1h");
  });
  test("non-positive / non-finite → 0ms", () => {
    expect(humanMs(0)).toBe("0ms");
    expect(humanMs(-5)).toBe("0ms");
    expect(humanMs(Number.NaN)).toBe("0ms");
  });
});

describe("executionDurationMs", () => {
  test("computes finished − started", () => {
    expect(executionDurationMs("2026-06-24T10:00:00.000Z", "2026-06-24T10:00:02.500Z")).toBe(2500);
  });
  test("null finished_at (still running) → null", () => {
    expect(executionDurationMs("2026-06-24T10:00:00.000Z", null)).toBeNull();
  });
  test("unparseable / negative → null", () => {
    expect(executionDurationMs("nope", "2026-06-24T10:00:00.000Z")).toBeNull();
    expect(executionDurationMs("2026-06-24T10:00:05.000Z", "2026-06-24T10:00:00.000Z")).toBeNull();
  });
});

describe("computeStepBottlenecks", () => {
  test("ranks slowest-first with pct of total step time", () => {
    const ranked = computeStepBottlenecks([
      { step_key: "fetch", duration_ms: 100, kind: "connector" },
      { step_key: "transform", duration_ms: 300, kind: "transform" },
      { step_key: "queued", duration_ms: 0 },
    ]);
    expect(ranked.map((r) => r.step_key)).toEqual(["transform", "fetch"]);
    expect(ranked[0]?.pct).toBe(75);
    expect(ranked[1]?.pct).toBe(25);
  });
  test("surfaces connector slug from request_meta", () => {
    const ranked = computeStepBottlenecks([
      {
        step_key: "call",
        duration_ms: 50,
        request_meta: { connector: { slug: "github" } },
      },
    ]);
    expect(ranked[0]?.connector_slug).toBe("github");
  });
  test("drops steps with no positive duration", () => {
    expect(
      computeStepBottlenecks([{ step_key: "x" }, { step_key: "y", duration_ms: null }]),
    ).toEqual([]);
  });
});
