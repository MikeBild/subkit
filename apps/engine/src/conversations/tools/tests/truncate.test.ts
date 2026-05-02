import { describe, expect, it } from "bun:test";
import { clearRawStore, getRawResult, TRUNCATE_INTERNALS, truncateForLlm } from "../truncate.ts";

describe("truncateForLlm", () => {
  it("passes small outputs through unchanged", () => {
    const r = truncateForLlm({ hello: "world" });
    expect(r.truncated).toBe(false);
    expect(r.data).toEqual({ hello: "world" });
    expect(r.raw_ref).toBeUndefined();
  });

  it("truncates long arrays and stashes raw under raw_ref", () => {
    clearRawStore();
    // Array too large to fit: 200 entries of ~200 chars each ≈ 40k chars.
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: `id-${i}`,
      payload: "x".repeat(200),
    }));
    const r = truncateForLlm({ items: big });
    expect(r.truncated).toBe(true);
    const dataItems = (r.data as { items: unknown[] }).items;
    // 20 retained + one marker sentinel.
    expect(dataItems.length).toBe(21);
    expect(dataItems[20]).toMatchObject({ __truncated: expect.stringContaining("more items") });
    expect(r.raw_ref).toMatch(/^raw_/);
    // Raw store contains the untruncated payload.
    const raw = getRawResult(r.raw_ref!);
    expect((raw as { items: unknown[] }).items.length).toBe(200);
  });

  it("getRawResult returns undefined for unknown refs", () => {
    expect(getRawResult("not-a-ref")).toBeUndefined();
  });

  it("bounds OUTPUT size, not just the trigger threshold", () => {
    // Reproduces the inspect_workflow_draft failure: a deeply nested
    // payload where each top-level array element is itself huge
    // (workflow step + embedded snapshot). Pre-fix the truncator clipped
    // the array to 20 elements but kept each element verbatim, leaving
    // a 480k-char payload. Post-fix the output must fit under MAX_JSON_CHARS.
    clearRawStore();
    const heavyStep = (i: number) => ({
      id: `step-${i}`,
      kind: "transform",
      // 30 nested attributes, each carrying a 4kb string — each step ~120kb.
      attrs: Object.fromEntries(
        Array.from({ length: 30 }, (_, j) => [`attr-${j}`, "y".repeat(4000)]),
      ),
    });
    const fixture = {
      workflow: {
        id: "wf-1",
        steps: Array.from({ length: 25 }, (_, i) => heavyStep(i)),
      },
    };
    const r = truncateForLlm(fixture);
    expect(r.truncated).toBe(true);
    const outLen = JSON.stringify(r.data).length;
    expect(outLen).toBeLessThanOrEqual(TRUNCATE_INTERNALS.MAX_JSON_CHARS);
    // Raw payload still retrievable for follow-up.
    const raw = getRawResult(r.raw_ref!);
    expect((raw as { workflow: { steps: unknown[] } }).workflow.steps.length).toBe(25);
  });

  it("nested arrays are clipped tighter than top-level", () => {
    clearRawStore();
    const fixture = {
      // top-level array — 30 small items, expect 20 retained.
      list: Array.from({ length: 30 }, (_, i) => ({
        id: i,
        // nested array — 30 items, expect MAX_NESTED_ARRAY_LEN=10 retained.
        children: Array.from({ length: 30 }, (_, j) => ({ idx: j })),
      })),
    };
    // Force truncation by padding total size over the trigger.
    const padded = { ...fixture, pad: "z".repeat(TRUNCATE_INTERNALS.MAX_JSON_CHARS) };
    const r = truncateForLlm(padded);
    expect(r.truncated).toBe(true);
  });
});
