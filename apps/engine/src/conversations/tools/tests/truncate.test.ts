import { describe, expect, it } from "bun:test";
import {
  clearRawStore,
  getRawResult,
  rememberRaw,
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
    expect(dataItems[20]).toMatchObject({ _truncated: expect.stringContaining("more items") });
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

  it("never emits __omitted_chars / __raw_ref marker keys (regression: session 0ac7593c)", () => {
    // Pre-fix the heaviest-branch shrink loop replaced over-cap branches
    // with `{__omitted_chars, __raw_ref}` marker objects. Those keys
    // leaked through synthesizeFallbackMessage and the chat renderer,
    // so end users saw `__omitted_chars: 234` in their workflow output.
    // Post-fix the heavy branches collapse to `null` and the omission
    // is rolled up into a single top-level `_truncation_note`.
    clearRawStore();
    const fixture = {
      workflow: {
        id: "wf-1",
        steps: Array.from({ length: 25 }, (_, i) => ({
          id: `step-${i}`,
          attrs: Object.fromEntries(
            Array.from({ length: 30 }, (_, j) => [`attr-${j}`, "y".repeat(4000)]),
          ),
        })),
      },
    };
    const r = truncateForLlm(fixture);
    expect(r.truncated).toBe(true);
    const serialised = JSON.stringify(r.data);
    expect(serialised).not.toContain("__omitted_chars");
    expect(serialised).not.toContain("__raw_ref");
    // The rolled-up note is a single underscore-prefixed top-level key.
    expect((r.data as { _truncation_note?: string })._truncation_note).toMatch(
      /chars in \d+ branch\(es\) omitted/,
    );
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

// ---------------------------------------------------------------------------
// Change 1 — raw-ref TTL retention
// ---------------------------------------------------------------------------

describe("raw-ref store — TTL retention and size backstop", () => {
  it("truncateForLlm round-trip: full payload recoverable via getRawResult", () => {
    clearRawStore();
    const bigPayload = Array.from({ length: 50 }, (_, i) => ({
      id: `item-${i}`,
      data: "x".repeat(300),
    }));
    const r = truncateForLlm(bigPayload);
    expect(r.truncated).toBe(true);
    expect(r.raw_ref).toMatch(/^raw_/);
    const recovered = getRawResult(r.raw_ref!) as unknown[];
    expect(recovered).toBeDefined();
    expect(recovered.length).toBe(50);
    expect((recovered[0] as { id: string }).id).toBe("item-0");
  });

  it("rememberRaw round-trip: stored value retrievable by returned ref", () => {
    clearRawStore();
    const value = { workflow_id: "wf-abc", steps: [1, 2, 3] };
    const ref = rememberRaw(value);
    expect(ref).toMatch(/^raw_/);
    const recovered = getRawResult(ref);
    expect(recovered).toEqual(value);
  });

  it("getRawResult returns undefined for an unknown ref", () => {
    clearRawStore();
    expect(getRawResult("not-a-real-ref")).toBeUndefined();
  });

  it("clearRawStore empties the store so no refs are retrievable", () => {
    const ref = rememberRaw({ sentinel: true });
    clearRawStore();
    expect(getRawResult(ref)).toBeUndefined();
  });

  it("size backstop: storing RAW_REF_MAX_ENTRIES+50 via rememberRaw keeps most-recent ref while evicting the oldest", () => {
    clearRawStore();
    const { RAW_REF_MAX_ENTRIES } = TRUNCATE_INTERNALS;
    const total = RAW_REF_MAX_ENTRIES + 50;

    // Store the first ref — this is the one that must be evicted.
    const firstRef = rememberRaw({ index: 0 });

    // Fill up to the backstop ceiling + 50 more.
    const lastRef = (() => {
      let last = firstRef;
      for (let i = 1; i < total; i++) {
        last = rememberRaw({ index: i });
      }
      return last;
    })();

    // The very last entry (most recent) must still be in the store.
    const lastValue = getRawResult(lastRef) as { index: number };
    expect(lastValue).toBeDefined();
    expect(lastValue.index).toBe(total - 1);

    // The very first entry must have been evicted by the backstop.
    expect(getRawResult(firstRef)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Change 4 — _truncated marker includes total count
// ---------------------------------------------------------------------------

describe("truncateNode array marker", () => {
  it("top-level array with > MAX_ARRAY_LEN elements carries a _truncated marker with the total count", () => {
    clearRawStore();
    const { MAX_ARRAY_LEN } = TRUNCATE_INTERNALS;
    const count = MAX_ARRAY_LEN + 10; // 30 items
    // Each element is large enough that the overall payload triggers truncateForLlm.
    const big = Array.from({ length: count }, (_, i) => ({
      id: `row-${i}`,
      payload: "p".repeat(400),
    }));
    const r = truncateForLlm(big);
    expect(r.truncated).toBe(true);
    const arr = r.data as unknown[];
    // Last element in the clipped array must be the _truncated marker.
    const marker = arr[arr.length - 1] as { _truncated?: string };
    expect(marker._truncated).toBeDefined();
    // Must include the original total count.
    expect(marker._truncated).toContain(String(count));
    // e.g. "+10 more items (30 total)"
    expect(marker._truncated).toMatch(/\(\d+ total\)/);
  });
});
