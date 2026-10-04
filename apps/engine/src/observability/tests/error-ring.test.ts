import { describe, expect, it } from "bun:test";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { type CapturedError, createErrorRing } from "../error-ring.ts";

const TEST_NOW_MS = getTestNow();

function mk(overrides: Partial<CapturedError> = {}): CapturedError {
  return {
    trace_id: "t-default",
    ts: new Date(TEST_NOW_MS).toISOString(),
    tenant_id: "tenant-a",
    method: "POST",
    path: "/v1/conversations",
    status: 500,
    code: "internal_error",
    message: "boom",
    stack: "Error: boom\n  at foo\n  at bar",
    bucket: "unhandled",
    ...overrides,
  };
}

describe("error ring", () => {
  it("evicts FIFO past capacity", () => {
    const ring = createErrorRing(3);
    ring.record(mk({ trace_id: "1" }));
    ring.record(mk({ trace_id: "2" }));
    ring.record(mk({ trace_id: "3" }));
    ring.record(mk({ trace_id: "4" }));
    expect(ring.size()).toBe(3);
    const traces = ring.tail({ limit: 10 }).map((e) => e.trace_id);
    expect(traces).toEqual(["4", "3", "2"]);
  });

  it("filters by tenant_id", () => {
    const ring = createErrorRing(10);
    ring.record(mk({ trace_id: "a", tenant_id: "tenant-a" }));
    ring.record(mk({ trace_id: "b", tenant_id: "tenant-b" }));
    ring.record(mk({ trace_id: "c", tenant_id: "tenant-a" }));
    const a = ring.tail({ tenant_id: "tenant-a" }).map((e) => e.trace_id);
    expect(a).toEqual(["c", "a"]);
  });

  it("filters by trace_id", () => {
    const ring = createErrorRing(10);
    ring.record(mk({ trace_id: "x" }));
    ring.record(mk({ trace_id: "y" }));
    expect(ring.tail({ trace_id: "y" })).toHaveLength(1);
    expect(ring.tail({ trace_id: "missing" })).toHaveLength(0);
  });

  it("filters by since", () => {
    const ring = createErrorRing(10);
    ring.record(mk({ trace_id: "old", ts: "2020-01-01T00:00:00.000Z" }));
    ring.record(mk({ trace_id: "new", ts: "2099-01-01T00:00:00.000Z" }));
    const since = new Date("2030-01-01T00:00:00.000Z");
    expect(ring.tail({ since }).map((e) => e.trace_id)).toEqual(["new"]);
  });

  it("truncates stacks larger than 8 KiB", () => {
    const ring = createErrorRing(2);
    const big = "x".repeat(9 * 1024);
    ring.record(mk({ stack: big }));
    const got = ring.tail()[0]?.stack ?? "";
    expect(got.length).toBeLessThanOrEqual(8 * 1024 + "\n…(truncated)".length);
    expect(got.endsWith("…(truncated)")).toBe(true);
  });
});
