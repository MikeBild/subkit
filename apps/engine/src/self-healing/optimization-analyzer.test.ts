// Web-scraper optimization analyzer unit tests.
//
// Pure function tests — no DB, no clock, no I/O.

import { describe, expect, test } from "bun:test";

import {
  type AnalyzerConfig,
  type AnalyzerRunSample,
  analyzeRuns,
  type OptimizationKind,
} from "./optimization-analyzer.ts";

const baseCfg: AnalyzerConfig = {
  trivial_markdown_bytes: 512,
  min_runs_before_proposing: 3,
  llms_txt_available: false,
};

function sample(overrides: Partial<AnalyzerRunSample> = {}): AnalyzerRunSample {
  return {
    pages_total: 10,
    pages_trivial: 0,
    pages_extract_too_large: 0,
    mean_wait_ms: 0,
    rate_limit_hits: 0,
    ...overrides,
  };
}

function kinds(out: { kind: OptimizationKind }[]): OptimizationKind[] {
  return out.map((c) => c.kind);
}

describe("optimization-analyzer", () => {
  test("emits no candidates when fewer than min_runs_before_proposing", () => {
    const runs = [sample(), sample()];
    expect(analyzeRuns(runs, baseCfg)).toEqual([]);
  });

  test("emits narrow_path_prefix when 95% of pages were trivial", () => {
    const runs = Array.from({ length: 5 }, () => sample({ pages_total: 100, pages_trivial: 95 }));
    const out = analyzeRuns(runs, baseCfg);
    expect(kinds(out)).toContain("narrow_path_prefix");
    const cand = out.find((c) => c.kind === "narrow_path_prefix");
    expect(cand?.estimated_savings_pct).toBeGreaterThan(0);
    expect(cand?.classification).toBe("safe");
  });

  test("emits raise_max_chars when 40% of pages hit extract_too_large", () => {
    const runs = Array.from({ length: 4 }, () =>
      sample({ pages_total: 10, pages_extract_too_large: 4 }),
    );
    const out = analyzeRuns(runs, baseCfg);
    expect(kinds(out)).toContain("raise_max_chars");
  });

  test("emits increase_wait_ms when 429s exceed threshold", () => {
    const runs = Array.from({ length: 3 }, () =>
      sample({ pages_total: 10, rate_limit_hits: 2, mean_wait_ms: 100 }),
    );
    const out = analyzeRuns(runs, baseCfg);
    const cand = out.find((c) => c.kind === "increase_wait_ms");
    expect(cand).toBeDefined();
    expect((cand!.diff as { new_value?: number }).new_value).toBeGreaterThanOrEqual(200);
  });

  test("emits prefer_llms_txt only when llms_txt_available", () => {
    const runs = Array.from({ length: 4 }, () => sample({ pages_total: 100, pages_trivial: 60 }));
    const out = analyzeRuns(runs, { ...baseCfg, llms_txt_available: true });
    expect(kinds(out)).toContain("prefer_llms_txt");
  });

  test("emits no candidates for a healthy workload", () => {
    const runs = Array.from({ length: 5 }, () => sample({ pages_total: 100, pages_trivial: 1 }));
    expect(analyzeRuns(runs, baseCfg)).toEqual([]);
  });

  test("returns deterministic output (same input → same output)", () => {
    const runs = Array.from({ length: 5 }, () => sample({ pages_total: 100, pages_trivial: 95 }));
    const a = analyzeRuns(runs, baseCfg);
    const b = analyzeRuns(runs, baseCfg);
    expect(a).toEqual(b);
  });
});
