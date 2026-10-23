import { describe, expect, test } from "bun:test";
import { RequestMetaSchema } from "../../request-meta-schema.ts";
import { sandboxRequestMeta } from "../transform.ts";

describe("transform sandbox request meta", () => {
  test("records run stats as a sandbox request meta without the worker pid", () => {
    const meta = sandboxRequestMeta({
      ticks: 42,
      duration_ms: 12.6,
      peak_memory_bytes: 2048,
      worker_pid: 1234,
    });
    expect(meta.request_meta).toEqual({
      driver: "sandbox",
      ticks: 42,
      duration_ms: 13,
      peak_memory_bytes: 2048,
    });
    expect(RequestMetaSchema.safeParse(meta.request_meta).success).toBe(true);
  });

  test("keeps a missing memory sample and omits meta without stats", () => {
    const meta = sandboxRequestMeta({ ticks: 0, duration_ms: 0, peak_memory_bytes: null });
    expect(RequestMetaSchema.parse(meta.request_meta)).toMatchObject({ peak_memory_bytes: null });
    expect(sandboxRequestMeta(undefined)).toEqual({});
  });
});
