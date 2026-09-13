// Regression: a large successful workflow output must reach the user as a
// SAMPLE with real rows, never vanish. Pre-fix the outer LLM-budget pass
// nulled the heaviest envelope branch — always `output` — and a 95-row
// success surfaced as "status=succeeded · no output" in production.

import { describe, expect, test } from "bun:test";

import { getRawResult, sampleWorkflowOutputForLlm } from "../truncate.ts";

describe("sampleWorkflowOutputForLlm", () => {
  test("small outputs pass through untouched", () => {
    const output = { org: "remotion-dev", total: 3, repos: [{ n: 1 }, { n: 2 }, { n: 3 }] };
    const r = sampleWorkflowOutputForLlm(output);
    expect(r.sampled).toBe(false);
    expect(r.value).toBe(output);
    expect(r.raw_ref).toBeUndefined();
  });

  test("null/undefined pass through", () => {
    expect(sampleWorkflowOutputForLlm(null)).toEqual({ value: null, sampled: false });
    expect(sampleWorkflowOutputForLlm(undefined)).toEqual({ value: undefined, sampled: false });
  });

  test("large array output samples leading rows with an in-band marker + raw_ref", () => {
    const repos = Array.from({ length: 95 }, (_, i) => ({
      name: `repo-${i}`,
      full_name: `org/repo-${i}`,
      stars: 1000 - i,
      description: `description for repository number ${i} with some padding text`,
      html_url: `https://github.com/org/repo-${i}`,
    }));
    const output = { org: "remotion-dev", total: 95, repos };
    const r = sampleWorkflowOutputForLlm(output);
    expect(r.sampled).toBe(true);
    // The sample carries REAL leading rows…
    const v = r.value as { repos: unknown[] };
    expect((v.repos[0] as { name: string }).name).toBe("repo-0");
    // …an explicit in-band marker so nobody mistakes it for the full set…
    expect(JSON.stringify(v.repos.at(-1))).toContain("sampled");
    expect(JSON.stringify(v.repos.at(-1))).toContain("of 95 items");
    // …and the FULL payload retrievable via the raw ref.
    expect(typeof r.raw_ref).toBe("string");
    const full = getRawResult(r.raw_ref!) as { repos: unknown[] };
    expect(full.repos).toHaveLength(95);
    // The sample itself stays under the envelope budget.
    expect(JSON.stringify(r.value).length).toBeLessThanOrEqual(5000);
  });

  test("long strings are head-clipped with a length marker", () => {
    const output = { blob: "x".repeat(20_000) };
    const r = sampleWorkflowOutputForLlm(output);
    expect(r.sampled).toBe(true);
    const v = r.value as { blob: string };
    expect(v.blob).toContain("more chars]");
    expect(v.blob.length).toBeLessThan(500);
  });
});
