// Unit tests for ConfigSchema. Pure logic; no I/O.

import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../schema.ts";

describe("ConfigSchema", () => {
  test("zero-config: empty input produces a fully-defaulted Config except for database.url", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = result.error.issues;
    expect(issues.length).toBeGreaterThan(0);
    const dbIssue = issues.find((i) => i.path.join(".") === "database.url");
    expect(dbIssue).toBeDefined();
    expect(dbIssue!.message).toBe("database.url is required");
  });

  test("with database.url: parses cleanly to defaults", () => {
    const result = ConfigSchema.safeParse({ database: { url: "postgres://x" } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.log.level).toBe("info");
    expect(result.data.log.format).toBe("ndjson");
    expect(result.data.server.port).toBe(3000);
    expect(result.data.server.tunnel_port).toBeNull();
    expect(result.data.llm.provider).toBe("mock");
    expect(result.data.llm.providers.anthropic.api_key).toBe("");
    expect(result.data.egress.mode).toBeNull();
    expect(result.data.egress.provider_hosts_extra).toEqual([]);
    expect(result.data.tunnel.registry_max).toBe(100);
    expect(result.data.errors.ring_size).toBe(100);
    expect(result.data.queue.concurrency).toBe(8);
    expect(result.data.tokens.monthly_budget).toBe(0);
  });

  test("rejects an invalid log.level", () => {
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      log: { level: "bogus" },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.path.join(".") === "log.level")).toBe(true);
  });

  test("rejects out-of-range queue.concurrency (> 64)", () => {
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      queue: { concurrency: 999 },
    });
    expect(r.success).toBe(false);
  });

  test("tenant overlay parses for any tenant id", () => {
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      tenants: {
        "tenant-a": { llm: { api_key: "tenant-a-key" } },
        "tenant-b": { tokens: { monthly_budget: 50_000 } },
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.tenants?.["tenant-a"]?.llm?.api_key).toBe("tenant-a-key");
    expect(r.data.tenants?.["tenant-b"]?.tokens?.monthly_budget).toBe(50_000);
  });
});
