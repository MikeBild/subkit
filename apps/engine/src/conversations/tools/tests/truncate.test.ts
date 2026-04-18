import { describe, expect, it } from "bun:test";
import { clearRawStore, getRawResult, truncateForLlm } from "../truncate.ts";

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
});
