// Fix 6(b) regression — the `array[4]<null>` incident (session
// 784c1b02). A loop's `output_preview` must NEVER render `null` for an
// iteration that actually ran:
//
//   - offloaded iteration payloads collapse to the labeled
//     `[offloaded:…]` stub (`previewOffloadRefs`), and
//   - the per-step LLM truncation pass replaces over-budget iteration
//     objects with a labeled `[omitted: … get_raw_result(…)]` stub —
//     not bare `null`, which the model read as "the loop collapsed all
//     body outputs to null" and restructured a working workflow.

import { describe, expect, it } from "bun:test";
import { previewOffloadRefs } from "../../../execution/offload-rehydrate.ts";
import { summarizeScopeShape } from "../../../workflows/scope-shape.ts";
import { clearRawStore, truncateStepPreviewForLlm } from "../truncate.ts";

/** Four fat iteration objects, shaped like the loop accumulator
 *  (`{ <body_step_id>: envelope }`), each well over the per-step
 *  preview budget so pass-2 has to shrink every one of them. */
function fatLoopPreview(): unknown[] {
  return Array.from({ length: 4 }, (_, i) => ({
    fetch_detail: {
      data: {
        id: `droplet-${i}`,
        specs: Object.fromEntries(
          Array.from({ length: 20 }, (_, j) => [`field_${j}`, "x".repeat(120)]),
        ),
      },
      duration_ms: 42,
      error: null,
      status_code: 200,
    },
  }));
}

function collectNulls(value: unknown, out: unknown[] = []): unknown[] {
  if (value === null) {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNulls(v, out);
    return out;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectNulls(v, out);
  }
  return out;
}

describe("loop output_preview never renders null for an iteration that ran", () => {
  it("truncation replaces over-budget iterations with labeled stubs, not null", () => {
    clearRawStore();
    const r = truncateStepPreviewForLlm(fatLoopPreview());
    expect(r.truncated).toBe(true);
    const arr = r.data as unknown[];
    // No iteration entry may be null — that's the array[4]<null> bug.
    for (const entry of arr) {
      expect(entry).not.toBeNull();
    }
    // Deep check: pass-2 must not have nulled ANY branch (the envelope
    // `error: null` fields are legitimately null; pass-2 only touches
    // object/string branches >64 chars, so a surviving null can only be
    // a pre-existing data null).
    const serialized = JSON.stringify(arr);
    expect(serialized).toContain("[omitted:");
    expect(serialized).toContain("get_raw_result");
    // The shape summary the model reads must not be `array[4]<null>`.
    expect(
      summarizeScopeShape(
        arr.filter(
          (e) =>
            !(
              typeof e === "object" &&
              e !== null &&
              "_truncated" in (e as Record<string, unknown>)
            ),
        ),
      ),
    ).not.toContain("<null>");
  });

  it("pass-2 stubs carry the omission size and the recovery ref", () => {
    clearRawStore();
    const r = truncateStepPreviewForLlm(fatLoopPreview());
    const stubs: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string" && v.startsWith("[omitted:")) stubs.push(v);
      else if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v !== null && typeof v === "object") {
        for (const c of Object.values(v as Record<string, unknown>)) walk(c);
      }
    };
    walk(r.data);
    expect(stubs.length).toBeGreaterThan(0);
    for (const stub of stubs) {
      expect(stub).toMatch(
        /^\[omitted: \d+ chars( · shape: .+)? — get_raw_result\(ref="raw_[0-9a-f-]+"\)\]$/,
      );
    }
  });

  it("offloaded iteration entries render as labeled [offloaded:…] stubs", () => {
    const iterationResults = [
      {
        fetch_detail: {
          data: {
            $offloaded: true,
            storage_uri: "s3://bucket/executions/abc/step.json",
            preview: '{"id":"droplet-0"…}',
            size_bytes: 1_048_576,
          },
          duration_ms: 42,
          error: null,
        },
      },
      {
        fetch_detail: {
          data: { id: "droplet-1", inline: true },
          duration_ms: 40,
          error: null,
        },
      },
    ];
    const previewed = previewOffloadRefs(iterationResults) as Array<{
      fetch_detail: { data: unknown };
    }>;
    // Offloaded entry → labeled primitive stub with redacted locator.
    expect(previewed[0]!.fetch_detail.data).toBe("[offloaded:s3://…:1048576B]");
    // Non-offloaded body results pass through faithfully.
    expect(previewed[1]!.fetch_detail.data).toEqual({ id: "droplet-1", inline: true });
    // No nulls anywhere for iterations that ran (the envelope's own
    // `error: null` is the only legitimate null).
    const nulls = collectNulls(previewed);
    expect(nulls.length).toBe(2); // exactly the two error:null fields
  });
});
