// Queue trace_id bridge — log ring assertion.
//
// The bridge contract: a job envelope stamped with a `trace_id` at enqueue
// time is re-read by `withJobContext` in the worker so every log the handler
// emits carries the same trace_id in its structured fields. This is a unit-
// level assertion: it drives `withJobContext` + `logger` and reads the result
// back from the in-memory log ring — the same surface that
// `GET /v1/diagnostics/logs` serves — without needing a real pg-boss queue.

import { describe, expect, test } from "bun:test";

import { getContext } from "../../logging/context.ts";
import { logger } from "../../logging/logger.ts";
import { logRing } from "../../observability/log-ring.ts";
import { withJobContext } from "../job-context.ts";

describe("queue trace_id bridge — log ring", () => {
  test("worker log emitted inside withJobContext carries the enqueued trace_id", () => {
    const TRACE = "bridge-test-trace-001";
    const TENANT = "bridge-tenant-001";
    const MODULE = "trace-bridge";
    const ACTION = "log-ring-check";

    logRing.clear();

    withJobContext({ trace_id: TRACE, tenant_id: TENANT }, () => {
      // Assert the context is set before logging.
      const ctx = getContext();
      expect(ctx.trace_id).toBe(TRACE);
      expect(ctx.tenant_id).toBe(TENANT);
      expect(ctx.request_source).toBe("queue");

      // Emit a structured log — the logger mirrors it to the ring with the
      // current context merged into `fields`.
      logger.info({
        module: MODULE,
        action: ACTION,
        msg: "downstream worker log",
        extra: "marker",
      });
    });

    // The ring should carry the entry with the trace_id from the envelope.
    const entries = logRing.tail({ module: MODULE, action: ACTION });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[0]!;
    // The context fields are merged into `fields` by `recordToRing`.
    expect(entry.fields.trace_id).toBe(TRACE);
    expect(entry.fields.tenant_id).toBe(TENANT);
    expect(entry.fields.request_source).toBe("queue");
    expect(entry.msg).toBe("downstream worker log");
    expect(entry.level).toBe("info");
  });

  test("a job without trace_id does not pollute the ring with a stale trace_id", () => {
    logRing.clear();

    withJobContext({ tenant_id: "other-tenant" }, () => {
      logger.info({ module: "trace-bridge", action: "no-trace", msg: "no trace" });
    });

    const entries = logRing.tail({ module: "trace-bridge", action: "no-trace" });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[0]!;
    // trace_id must be absent when the envelope doesn't carry it.
    expect(entry.fields.trace_id).toBeUndefined();
    expect(entry.fields.tenant_id).toBe("other-tenant");
  });

  test("ring entries from different job contexts are independently scoped", () => {
    logRing.clear();

    withJobContext({ trace_id: "trace-A", tenant_id: "tenant-A" }, () => {
      logger.info({ module: "trace-bridge", action: "scope-check", msg: "A" });
    });
    withJobContext({ trace_id: "trace-B", tenant_id: "tenant-B" }, () => {
      logger.info({ module: "trace-bridge", action: "scope-check", msg: "B" });
    });

    const entries = logRing.tail({ module: "trace-bridge", action: "scope-check" });
    // Newest-first (default tail order).
    expect(entries.length).toBe(2);
    const msgB = entries.find((e) => e.msg === "B");
    const msgA = entries.find((e) => e.msg === "A");
    expect(msgB?.fields.trace_id).toBe("trace-B");
    expect(msgB?.fields.tenant_id).toBe("tenant-B");
    expect(msgA?.fields.trace_id).toBe("trace-A");
    expect(msgA?.fields.tenant_id).toBe("tenant-A");
  });
});
