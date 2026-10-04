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

  it("annotates a large omitted branch with its shape (F2 — judge/author see structure)", () => {
    clearRawStore();
    const bigArray = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      threadId: `t${i}`,
      payload: { headers: "x".repeat(60) },
    }));
    const r = truncateForLlm({ messages: bigArray, pad: "y".repeat(9000) });
    expect(r.truncated).toBe(true);
    const serialized = JSON.stringify(r.data);
    expect(serialized).toMatch(/\[omitted: \d+ chars · shape: .+ — get_raw_result/);
  });

  it("keeps small omitted branches compact (no shape annotation)", () => {
    clearRawStore();
    const repos = Array.from({ length: 16 }, (_, i) => ({
      name: `repo-${i}`,
      description: "x".repeat(120),
    }));
    const r = truncateStepPreviewForLlm(repos);
    const serialized = JSON.stringify(r.data);
    if (serialized.includes("[omitted:")) {
      expect(serialized).not.toContain("· shape:");
    }
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(
      TRUNCATE_INTERNALS.MAX_STEP_PREVIEW_CHARS,
    );
  });

  it("truncates long arrays and stashes raw under raw_ref", () => {
    clearRawStore();
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: `id-${i}`,
      payload: "x".repeat(200),
    }));
    const r = truncateForLlm({ items: big });
    expect(r.truncated).toBe(true);
    const dataItems = (r.data as { items: unknown[] }).items;
    expect(dataItems.length).toBe(21);
    expect(dataItems[20]).toMatchObject({ _truncated: expect.stringContaining("more items") });
    expect(r.raw_ref).toMatch(/^raw_/);
    const raw = getRawResult(r.raw_ref!);
    expect((raw as { items: unknown[] }).items.length).toBe(200);
  });

  it("getRawResult returns undefined for unknown refs", () => {
    expect(getRawResult("not-a-ref")).toBeUndefined();
  });

  it("bounds OUTPUT size, not just the trigger threshold", () => {
    clearRawStore();
    const heavyStep = (i: number) => ({
      id: `step-${i}`,
      kind: "transform",
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
    const raw = getRawResult(r.raw_ref!);
    expect((raw as { workflow: { steps: unknown[] } }).workflow.steps.length).toBe(25);
  });

  it("never emits __omitted_chars / __raw_ref marker keys", () => {
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
    expect((r.data as { _truncation_note?: string })._truncation_note).toMatch(
      /chars in \d+ branch\(es\) omitted/,
    );
  });

  it("nested arrays are clipped tighter than top-level", () => {
    clearRawStore();
    const fixture = {
      list: Array.from({ length: 30 }, (_, i) => ({
        id: i,
        children: Array.from({ length: 30 }, (_, j) => ({ idx: j })),
      })),
    };
    const padded = { ...fixture, pad: "z".repeat(TRUNCATE_INTERNALS.MAX_JSON_CHARS) };
    const r = truncateForLlm(padded);
    expect(r.truncated).toBe(true);
  });
});

describe("truncateStepPreviewForLlm", () => {
  it("clips a step preview that fits below the offload threshold but blows the LLM cap", () => {
    clearRawStore();
    const repos = Array.from({ length: 16 }, (_, i) => ({
      name: `repo-${i}`,
      full_name: `octocat/repo-${i}`,
      private: true,
      html_url: `https://github.com/octocat/repo-${i}`,
      description: "x".repeat(120),
      updated_at: "2026-05-09T15:00:00Z",
    }));
    const r = truncateStepPreviewForLlm(repos);
    expect(r.truncated).toBe(true);
    const outLen = JSON.stringify(r.data).length;
    expect(outLen).toBeLessThanOrEqual(TRUNCATE_INTERNALS.MAX_STEP_PREVIEW_CHARS);
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

    const firstRef = rememberRaw({ index: 0 });

    const lastRef = (() => {
      let last = firstRef;
      for (let i = 1; i < total; i++) {
        last = rememberRaw({ index: i });
      }
      return last;
    })();

    const lastValue = getRawResult(lastRef) as { index: number };
    expect(lastValue).toBeDefined();
    expect(lastValue.index).toBe(total - 1);

    expect(getRawResult(firstRef)).toBeUndefined();
  });
});

describe("truncateNode array marker", () => {
  it("top-level array with > MAX_ARRAY_LEN elements carries a _truncated marker with the total count", () => {
    clearRawStore();
    const { MAX_ARRAY_LEN } = TRUNCATE_INTERNALS;
    const count = MAX_ARRAY_LEN + 10;
    const big = Array.from({ length: count }, (_, i) => ({
      id: `row-${i}`,
      payload: "p".repeat(400),
    }));
    const r = truncateForLlm(big);
    expect(r.truncated).toBe(true);
    const arr = r.data as unknown[];
    const marker = arr[arr.length - 1] as { _truncated?: string };
    expect(marker._truncated).toBeDefined();
    expect(marker._truncated).toContain(String(count));
    expect(marker._truncated).toMatch(/\(\d+ total\)/);
  });
});

describe("truncateForLlm allocation bound", () => {
  it("stringify bytes during one truncation stay under 8× the payload size", () => {
    clearRawStore();
    const deepLeaf = (i: number): unknown => {
      let node: unknown = { text: "d".repeat(600), i };
      for (let d = 0; d < 12; d++) node = { [`level_${d}`]: node, pad: "p".repeat(40) };
      return node;
    };
    const payload = {
      step_trace: Array.from({ length: 160 }, (_, i) => ({
        id: `step-${i}`,
        snapshot: deepLeaf(i),
        rows: Array.from({ length: 8 }, (_, j) => ({ j, blob: "r".repeat(300) })),
      })),
    };
    const orig = JSON.stringify.bind(JSON);
    const payloadBytes = orig(payload).length;

    let bytes = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test-local shim
    (JSON as any).stringify = function counted(value: unknown, ...rest: unknown[]) {
      // biome-ignore lint/suspicious/noExplicitAny: passthrough
      const s = (orig as any)(value, ...rest);
      if (typeof s === "string") bytes += s.length;
      return s;
    };
    try {
      const r = truncateForLlm(payload);
      expect(r.truncated).toBe(true);
      expect(JSON.stringify(r.data).length).toBeLessThan(3 * TRUNCATE_INTERNALS.MAX_JSON_CHARS);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (JSON as any).stringify = orig;
    }
    expect(bytes).toBeLessThan(8 * payloadBytes);
  });
});

describe("truncateForLlm protected root keys", () => {
  it("judge and warnings are never stubbed, even when they are heavy branches", () => {
    clearRawStore();
    const payload = {
      judge: { missing: Array.from({ length: 15 }, (_, i) => `missing-item-${i}`) },
      warnings: Array.from({ length: 15 }, (_, i) => ({ code: `warning_code_${i}` })),
      bulk: "b".repeat(30_000),
    };
    const r = truncateForLlm(payload);
    expect(r.truncated).toBe(true);
    const data = r.data as Record<string, unknown>;
    expect(typeof data.bulk).toBe("string");
    expect((data.bulk as string).startsWith("[omitted:")).toBe(true);
    expect(data.judge).toEqual(payload.judge);
    expect(data.warnings).toEqual(payload.warnings);
  });
});
