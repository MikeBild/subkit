// GC6 — chunker 3 MB per-page cap regression test.
//
// The chunker already truncates oversized pieces and marks
// `truncated: true` on the chunk, but GC6 asks for an explicit
// regression against a 4 MB synthetic input so future refactors cannot
// quietly undo the cap.

import { describe, expect, test } from "bun:test";
import { PER_PAGE_BYTES } from "../budgets.ts";
import { fingerprintChunks } from "../chunker.ts";

describe("docs-ingestion/chunker 3 MB cap", () => {
  test("a 4 MB chunk body is trimmed to 3 MB with truncated=true", () => {
    // Single paragraph of 4 MB so the budget-splitter emits exactly one
    // piece. We bump the split budget above the per-page cap so the
    // splitter returns the whole block in one shot — the chunker's
    // hard cap is what we want to exercise.
    const oversized = "x".repeat(4 * 1024 * 1024);
    const warnings: string[] = [];

    const out = fingerprintChunks([{ title: "oversized", content: oversized }], {
      splitBudget: 8 * 1024 * 1024,
      onTruncate: (message) => warnings.push(message),
    });

    expect(out.length).toBe(1);
    const chunk = out[0];
    expect(chunk).toBeDefined();
    expect(chunk?.truncated).toBe(true);
    expect(chunk?.byte_size).toBeLessThanOrEqual(PER_PAGE_BYTES);
    expect(chunk?.byte_size).toBe(PER_PAGE_BYTES); // ASCII => exact hit
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("trimmed to");
  });
});
