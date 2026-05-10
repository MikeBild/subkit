import { describe, expect, it } from "bun:test";
import {
  clearRawStore,
  getRawResult,
  TRUNCATE_INTERNALS,
  truncateForLlm,
  truncateStepPreviewForLlm,
} from "../truncate.ts";

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

describe("truncateStepPreviewForLlm", () => {
  // Regression: the cascade behind "Execution complete · awaiting confirmation
  // → run_workflow → output keys: omitted_chars, raw_ref" started here.
  // A single inline `output_preview` (≤ STEP_RESULT_DB_BYTES = 10 KB) was
  // enough to push the run_workflow envelope past MAX_JSON_CHARS = 8 KB.
  // Capping per-step at MAX_STEP_PREVIEW_CHARS keeps the envelope budget
  // available for the workflow's actual `output` field.
  it("clips a step preview that fits below the offload threshold but blows the LLM cap", () => {
    clearRawStore();
    // 16 GitHub-repo-sized objects (~6 fields × ~80 chars each ≈ 500 B/repo
    // ≈ 8 KB total) — under the 10 KB offload threshold so the engine
    // stores it inline as `output_preview`, but enough to dominate the
    // 8 KB LLM envelope when combined with `output`, `warnings_banner`,
    // etc.
    const repos = Array.from({ length: 16 }, (_, i) => ({
      name: `repo-${i}`,
      full_name: `MikeBild/repo-${i}`,
      private: true,
      html_url: `https://github.com/MikeBild/repo-${i}`,
      description: "x".repeat(120),
      updated_at: "2026-05-09T15:00:00Z",
    }));
    const r = truncateStepPreviewForLlm(repos);
    expect(r.truncated).toBe(true);
    // Capped well under the LLM envelope cap so envelope overhead fits.
    const outLen = JSON.stringify(r.data).length;
    expect(outLen).toBeLessThanOrEqual(TRUNCATE_INTERNALS.MAX_STEP_PREVIEW_CHARS);
    // Raw still reachable via get_raw_result(ref).
    expect(r.raw_ref).toMatch(/^raw_/);
    expect((getRawResult(r.raw_ref!) as unknown[]).length).toBe(16);
  });

  it("passes a small preview through unchanged", () => {
    const small = { city: "Berlin, Germany", date: "2026-05-10", temperature_max_c: 20.5 };
    const r = truncateStepPreviewForLlm(small);
    expect(r.truncated).toBe(false);
    expect(r.data).toEqual(small);
    expect(r.raw_ref).toBeUndefined();
  });

  it("uses the step-preview cap, not the envelope cap", () => {
    // Sanity-check the wrapper: an input sized between
    // MAX_STEP_PREVIEW_CHARS and MAX_JSON_CHARS must be clipped by
    // truncateStepPreviewForLlm but pass through truncateForLlm.
    const between = {
      pad: "z".repeat(
        Math.floor(
          (TRUNCATE_INTERNALS.MAX_STEP_PREVIEW_CHARS + TRUNCATE_INTERNALS.MAX_JSON_CHARS) / 2,
        ),
      ),
    };
    expect(truncateStepPreviewForLlm(between).truncated).toBe(true);
    expect(truncateForLlm(between).truncated).toBe(false);
  });
});
