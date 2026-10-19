import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../schema.ts";
import { dottedPath, findLeafByPath, listConfigLeaves } from "../walk.ts";

describe("ConfigSchema", () => {
  test("Cockpit root redirection is an opt-in global boolean", () => {
    const defaults = ConfigSchema.parse({ database: { url: "postgres://x" } });
    expect(defaults.server.root_redirect_to_cockpit).toBe(false);
    expect(findLeafByPath("server.root_redirect_to_cockpit")?.meta.scope).toBe("global");
    expect(
      ConfigSchema.parse({
        database: { url: "postgres://x" },
        server: { root_redirect_to_cockpit: true },
      }).server.root_redirect_to_cockpit,
    ).toBe(true);
    expect(
      ConfigSchema.safeParse({
        database: { url: "postgres://x" },
        server: { root_redirect_to_cockpit: "https://external.example.test" },
      }).success,
    ).toBe(false);
  });

  test("database connection limits are positive, bounded, global and restart-required", () => {
    const database = ConfigSchema.parse({ database: { url: "postgres://x" } }).database;
    expect(database.pool_max).toBe(10);
    expect(database.connect_timeout_ms).toBe(10_000);
    expect(database.query_timeout_ms).toBe(150_000);
    expect(database.statement_timeout_ms).toBe(120_000);
    for (const field of [
      "pool_max",
      "connect_timeout_ms",
      "query_timeout_ms",
      "statement_timeout_ms",
      "idle_timeout_ms",
      "keepalive_delay_ms",
    ]) {
      expect(
        ConfigSchema.safeParse({ database: { url: "postgres://x", [field]: 0 } }).success,
      ).toBe(false);
      expect(
        ConfigSchema.safeParse({
          database: { url: "postgres://x", [field]: Number.MAX_SAFE_INTEGER },
        }).success,
      ).toBe(false);
      const leaf = findLeafByPath(`database.${field}`);
      expect(leaf?.meta.scope).toBe("global");
      expect(leaf?.meta.requiresRestart).toBe(true);
    }
  });
  test("new REPL defaults allow preparation while explicit stored modes remain unchanged", () => {
    expect(ConfigSchema.parse({ database: { url: "postgres://x" } }).repl.permissionMode).toBe(
      "auto",
    );
    for (const permissionMode of ["ask", "auto", "plan", "yolo"] as const) {
      expect(
        ConfigSchema.parse({ database: { url: "postgres://x" }, repl: { permissionMode } }).repl
          .permissionMode,
      ).toBe(permissionMode);
    }
  });
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
    expect(result.data.queue.concurrency).toBe(1);
    expect(result.data.queue.abort_poll_interval_ms).toBe(500);
    expect(result.data.queue.crash_recovery_sweep_interval_ms).toBe(60_000);
    expect(result.data.tokens.monthly_budget).toBe(0);
  });

  test("sandbox.max_transform_wall_ms defaults to five minutes and must be a positive integer", () => {
    const parsed = ConfigSchema.parse({ database: { url: "postgres://x" } });
    expect(parsed.sandbox.max_transform_wall_ms).toBe(300_000);
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      sandbox: { max_transform_wall_ms: 0 },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.path.join(".") === "sandbox.max_transform_wall_ms")).toBe(
      true,
    );
  });

  test("sandbox worker controls have bounded defaults and preserve per-tenant fairness", () => {
    const parsed = ConfigSchema.parse({ database: { url: "postgres://x" } });
    expect(parsed.sandbox.queue_limit).toBe(32);
    expect(parsed.sandbox.tenant_queue_limit).toBe(8);
    expect(parsed.sandbox.ipc_max_bytes).toBe(32 * 1024 * 1024);
    expect(parsed.sandbox.worker_rss_bytes).toBe(512 * 1024 * 1024);
    const r = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      sandbox: { queue_limit: 4, tenant_queue_limit: 5 },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.path.join(".") === "sandbox.tenant_queue_limit")).toBe(
      true,
    );
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

  test("auth rejects confidential client secrets in runtime provider configuration", () => {
    const result = ConfigSchema.safeParse({
      database: { url: "postgres://x" },
      auth: {
        providers: [
          {
            protocol: "oidc",
            id: "public-oidc",
            label: "Public OIDC",
            issuer_url: "https://identity.example.test",
            client_id: "client",
            client_secret: "must-not-be-persisted",
          },
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

  describe("oidc_bearer provider", () => {
    const provider = {
      protocol: "oidc_bearer",
      id: "app-accounts",
      label: "App account",
      issuer_url: "https://issuer.example.test",
      audience: "app-audience",
      product_id: "app",
      required_claims: [{ path: "idp", equals: "primary" }],
    };
    const parse = (override: Record<string, unknown>, drop: string[] = []) => {
      const candidate: Record<string, unknown> = { ...provider, ...override };
      for (const key of drop) delete candidate[key];
      return ConfigSchema.safeParse({
        database: { url: "postgres://x" },
        auth: { providers: [candidate] },
      });
    };

    test("explicit audience and required_claims parse", () => {
      const result = parse({});
      expect(result.success).toBe(true);
      if (!result.success) return;
      const parsed = result.data.auth.providers[0];
      expect(parsed?.protocol === "oidc_bearer" && parsed.audience).toBe("app-audience");
    });

    test("an explicitly empty required_claims list parses", () => {
      expect(parse({ required_claims: [] }).success).toBe(true);
    });

    test("a provider without audience is rejected naming the field", () => {
      const result = parse({}, ["audience"]);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.some((issue) => issue.path.includes("audience"))).toBe(true);
    });

    test("a provider without required_claims is rejected naming the field", () => {
      const result = parse({}, ["required_claims"]);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.some((issue) => issue.path.includes("required_claims"))).toBe(
        true,
      );
    });
  });
});
