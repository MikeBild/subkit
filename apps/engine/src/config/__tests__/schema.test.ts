// Unit tests for ConfigSchema. Pure logic; no I/O.

import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../schema.ts";
import { dottedPath, findLeafByPath, listConfigLeaves } from "../walk.ts";

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
    expect(result.data.llm.provider).toBe("mock");
    expect(result.data.llm.providers.anthropic.api_key).toBe("");
    expect(result.data.egress.mode).toBeNull();
    expect(result.data.egress.provider_hosts_extra).toEqual([]);
    expect(result.data.errors.ring_size).toBe(100);
    expect(result.data.queue.concurrency).toBe(8);
    expect(result.data.queue.abort_poll_interval_ms).toBe(500);
    expect(result.data.queue.crash_recovery_sweep_interval_ms).toBe(60_000);
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

  test("rejects an execution abort poll interval below the control-plane floor", () => {
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      queue: { abort_poll_interval_ms: 99 },
    });
    expect(r.success).toBe(false);
  });

  test("rejects a crash recovery sweep interval below the operational floor", () => {
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      queue: { crash_recovery_sweep_interval_ms: 999 },
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

  test("auth accepts one product-local list with API key and OIDC", () => {
    const result = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      auth: {
        providers: [
          { protocol: "api_key", id: "api-key", label: "SubKit API key" },
          {
            protocol: "oidc",
            id: "workforce-oidc",
            label: "Workforce OIDC",
            issuer_url: "https://identity.example.test",
            client_id: "client",
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.auth.providers.map((provider) => provider.protocol)).toEqual([
      "api_key",
      "oidc",
    ]);
  });

  test("auth rejects duplicate named OIDC provider ids", () => {
    const provider = {
      id: "workforce-oidc",
      label: "Workforce OIDC",
      issuer_url: "https://identity.example.test",
      client_id: "client",
    };
    const result = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      auth: {
        providers: [
          { protocol: "oidc", ...provider },
          { protocol: "oidc", ...provider },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  test("auth rejects removed provider-specific configuration", () => {
    const result = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      auth: { provider: "oidc", oidc: { issuer_url: "https://identity.example.test" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("ConfigSchema — llm.web_search leaf", () => {
  // Regression: the leaf was added without a test; these cases ensure the
  // default, round-trip, and meta scope all stay in sync with the schema.

  test("default value is true (web search enabled by default)", () => {
    const r = ConfigSchema.safeParse({ database: { url: "postgres://x" } });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.llm.web_search).toBe(true);
  });

  test("explicit false round-trips through parse", () => {
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      llm: { web_search: false },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.llm.web_search).toBe(false);
  });

  test("explicit true round-trips through parse", () => {
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      llm: { web_search: true },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.llm.web_search).toBe(true);
  });

  test("non-boolean value is rejected", () => {
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      llm: { web_search: "yes" },
    });
    expect(r.success).toBe(false);
  });

  test("leaf has scope:tenant in the schema walker", () => {
    const leaf = findLeafByPath("llm.web_search");
    expect(leaf).toBeDefined();
    expect(leaf!.kind).toBe("boolean");
    expect(leaf!.meta.scope).toBe("tenant");
  });

  test("llm.web_search appears in the tenant-scoped leaf set", () => {
    const tenantPaths = new Set(
      listConfigLeaves()
        .filter((l) => l.meta.scope === "tenant")
        .map(dottedPath),
    );
    expect(tenantPaths.has("llm.web_search")).toBe(true);
  });

  test("sibling boolean llm.context_1m is also tenant-scoped (parity check)", () => {
    const leaf = findLeafByPath("llm.context_1m");
    expect(leaf).toBeDefined();
    expect(leaf!.meta.scope).toBe("tenant");
  });
});
