import { describe, expect, test } from "bun:test";
import { PER_PAGE_BYTES } from "../budgets.ts";
import { fingerprintChunks } from "../chunker.ts";

describe("docs-ingestion/chunker 3 MB cap", () => {
  test("a 4 MB chunk body is trimmed to 3 MB with truncated=true", () => {
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
    expect(chunk?.byte_size).toBe(PER_PAGE_BYTES);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("trimmed to");
  });
});
