import { describe, expect, test } from "bun:test";
import { buildServiceMetadata, mintTraceId, ServiceMetadataSchema } from "../service-metadata.ts";

describe("ServiceMetadata", () => {
  test("schema accepts a fully-populated metadata block", () => {
    const meta = ServiceMetadataSchema.parse({
      trace_id: "00000000-0000-0000-0000-000000000001",
      tenant_id: "tenant-1",
      actor_id: "user-1",
      actor_email: "alice@example.com",
      request_source: "api",
    });
    expect(meta.trace_id).toBeDefined();
  });

  test("schema rejects missing tenant_id", () => {
    expect(() =>
      ServiceMetadataSchema.parse({
        trace_id: "t",
        actor_id: null,
        actor_email: null,
        request_source: "api",
      }),
    ).toThrow();
  });

  test("schema rejects unknown request_source", () => {
    expect(() =>
      ServiceMetadataSchema.parse({
        trace_id: "t",
        tenant_id: "tenant-1",
        actor_id: null,
        actor_email: null,
        request_source: "unknown",
      }),
    ).toThrow();
  });

  test("buildServiceMetadata mints a trace_id when none is supplied", () => {
    const meta = buildServiceMetadata({
      tenant_id: "tenant-1",
      request_source: "scheduler",
    });
    expect(meta.trace_id.length).toBeGreaterThan(0);
    expect(meta.actor_id).toBeNull();
    expect(meta.actor_email).toBeNull();
  });

  test("buildServiceMetadata preserves a supplied trace_id", () => {
    const meta = buildServiceMetadata({
      trace_id: "custom-trace",
      tenant_id: "tenant-1",
      request_source: "cli",
    });
    expect(meta.trace_id).toBe("custom-trace");
  });

  test("buildServiceMetadata accepts every valid request_source", () => {
    const sources = ["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"] as const;
    for (const source of sources) {
      const meta = buildServiceMetadata({ tenant_id: "tenant-1", request_source: source });
      expect(meta.request_source).toBe(source);
    }
  });

  test("mintTraceId returns distinct values per call", () => {
    const a = mintTraceId();
    const b = mintTraceId();
    expect(a).not.toBe(b);
  });
});
