import { describe, expect, test } from "bun:test";

import { getContext } from "../logging/context.ts";
import { withJobContext } from "./job-context.ts";

describe("withJobContext", () => {
  test("stamps request_source=queue plus the envelope correlation fields", () => {
    const data = {
      trace_id: "abc123",
      tenant_id: "tenant-1",
      execution_id: "exec-1",
      workflow_id: "wf-1",
    };
    const ctx = withJobContext(data, () => getContext());
    expect(ctx.request_source).toBe("queue");
    expect(ctx.trace_id).toBe("abc123");
    expect(ctx.tenant_id).toBe("tenant-1");
    expect(ctx.execution_id).toBe("exec-1");
    expect(ctx.workflow_id).toBe("wf-1");
  });

  test("omits fields the envelope does not carry", () => {
    const ctx = withJobContext({ tenant_id: "tenant-2" }, () => getContext());
    expect(ctx.request_source).toBe("queue");
    expect(ctx.tenant_id).toBe("tenant-2");
    expect(ctx.trace_id).toBeUndefined();
    expect(ctx.execution_id).toBeUndefined();
  });

  test("a null trace_id is treated as absent", () => {
    const ctx = withJobContext({ tenant_id: "t", trace_id: null }, () => getContext());
    expect(ctx.trace_id).toBeUndefined();
  });

  test("defensive on null / non-object envelopes", () => {
    expect(withJobContext(null, () => getContext()).request_source).toBe("queue");
    expect(withJobContext(undefined, () => getContext()).tenant_id).toBeUndefined();
  });

  test("returns the wrapped function's value", () => {
    expect(withJobContext({ tenant_id: "t" }, () => 42)).toBe(42);
  });
});
