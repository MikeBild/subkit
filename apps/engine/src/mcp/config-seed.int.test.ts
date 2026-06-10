// Integration tests for reconcileMcpServersFromConfig (#171).
//
// Coverage:
//   - first run inserts declared servers (inserted tally correct)
//   - second run with unchanged config is a no-op (unchanged tally, no DB writes)
//   - config change triggers update (updated tally, row reflects new value)
//   - zero-conf tenant (no mcp.servers) → outcome 0/0/0/0
//   - audit rows: insert writes "mcp_server.registered"; no-op writes none
//   - duplicate namespaces within one tenant's array are rejected at PARSE
//     time (config-validation error at the boundary, not a silent clobber)
//   - none/null auth normalization: a decl with no `auth` vs a stored row
//     with auth_config {kind:"none"} compares equal → no spurious update on
//     re-run (idempotency holds for mixed-origin rows)
//
// Config injection: uses _resetConfigForTests + loadConfig with a temp
// config file (same approach as egress-guard.test.ts).

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { auditLog, mcpServers, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { logger } from "../logging/logger.ts";
import { createMcpServer } from "./client/registry.ts";
import { reconcileMcpServersFromConfig } from "./config-seed.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;
let savedDbUrl: string | undefined;

// Temp dir for config files.
const configDir = mkdtempSync(join(tmpdir(), "sk-mcp-seed-"));

// Monotonic counter for unique config filenames — deterministic (no Date.now).
let configFileSeq = 0;

function writeConfigFor(tenantAServers: unknown[], tenantBServers?: unknown[]): string {
  const path = join(configDir, `cfg-${configFileSeq++}.json`);
  const cfg: Record<string, unknown> = {
    tenants: {
      [tenantA]: { mcp: { servers: tenantAServers } },
    },
  };
  if (tenantBServers !== undefined && tenantB) {
    (cfg.tenants as Record<string, unknown>)[tenantB] = { mcp: { servers: tenantBServers } };
  }
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

async function loadCfg(configPath: string) {
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: ctx.url, NODE_ENV: "test" },
    configPathOverride: configPath,
  });
}

beforeAll(async () => {
  ctx = await createTestDb("mcp-config-seed");
  savedDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = ctx.url;

  const [a] = await ctx.db
    .insert(tenants)
    .values({ slug: "seed-t-a", display_name: "Seed Tenant A" })
    .returning();
  const [b] = await ctx.db
    .insert(tenants)
    .values({ slug: "seed-t-b", display_name: "Seed Tenant B" })
    .returning();
  tenantA = a!.id;
  tenantB = b!.id;
}, 30_000);

afterAll(async () => {
  _resetConfigForTests();
  if (savedDbUrl !== undefined) {
    process.env.DATABASE_URL = savedDbUrl;
  } else {
    delete process.env.DATABASE_URL;
  }
  await ctx.cleanup();
}, 30_000);

afterEach(() => {
  // Each test loads its own config; always reset so the next test starts clean.
  _resetConfigForTests();
});

// ── happy path ────────────────────────────────────────────────────────────────

describe("first run inserts declared servers", () => {
  test("inserts two servers for tenant A, tally is correct", async () => {
    await loadCfg(
      writeConfigFor([
        {
          name: "Acme MCP",
          namespace: "acmeseed",
          transport: "http",
          url: "https://acme.seed.test",
        },
        {
          name: "Example MCP",
          namespace: "exampleseed",
          transport: "http",
          url: "https://example.seed.test",
        },
      ]),
    );

    const outcome = await reconcileMcpServersFromConfig(ctx.db);
    expect(outcome.inserted).toBe(2);
    expect(outcome.updated).toBe(0);
    expect(outcome.unchanged).toBe(0);
    expect(outcome.failed).toBe(0);

    const rows = await ctx.db.select().from(mcpServers).where(eq(mcpServers.tenant_id, tenantA));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const ns = rows.map((r) => r.namespace);
    expect(ns).toContain("acmeseed");
    expect(ns).toContain("exampleseed");
  });
});

// ── idempotency ───────────────────────────────────────────────────────────────

describe("second run with unchanged config is a no-op", () => {
  test("unchanged = 1, inserted = 0, updated = 0", async () => {
    const decls = [
      { name: "Noop MCP", namespace: "noopseed", transport: "http", url: "https://noop.seed.test" },
    ];

    // First run — inserts.
    await loadCfg(writeConfigFor(decls));
    const first = await reconcileMcpServersFromConfig(ctx.db);
    expect(first.inserted).toBe(1);

    // Second run with the same config.
    await loadCfg(writeConfigFor(decls));
    const second = await reconcileMcpServersFromConfig(ctx.db);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.failed).toBe(0);
  });
});

// ── config change triggers update ─────────────────────────────────────────────

describe("config change triggers update", () => {
  test("url change → updated tally = 1, row reflects new url", async () => {
    const ns = "updatedseed";
    await loadCfg(
      writeConfigFor([
        {
          name: "Update MCP",
          namespace: ns,
          transport: "http",
          url: "https://v1.update.seed.test",
        },
      ]),
    );
    await reconcileMcpServersFromConfig(ctx.db);

    // Change url in config.
    await loadCfg(
      writeConfigFor([
        {
          name: "Update MCP",
          namespace: ns,
          transport: "http",
          url: "https://v2.update.seed.test",
        },
      ]),
    );
    const second = await reconcileMcpServersFromConfig(ctx.db);
    expect(second.updated).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(0);

    const rows = await ctx.db.select().from(mcpServers).where(eq(mcpServers.tenant_id, tenantA));
    const row = rows.find((r) => r.namespace === ns);
    expect(row?.url).toBe("https://v2.update.seed.test");
  });

  test("name change → updated tally = 1, row reflects new name", async () => {
    const ns = "renamedseed";
    await loadCfg(
      writeConfigFor([
        {
          name: "Old Name MCP",
          namespace: ns,
          transport: "http",
          url: "https://renamed.seed.test",
        },
      ]),
    );
    await reconcileMcpServersFromConfig(ctx.db);

    await loadCfg(
      writeConfigFor([
        {
          name: "New Name MCP",
          namespace: ns,
          transport: "http",
          url: "https://renamed.seed.test",
        },
      ]),
    );
    const outcome = await reconcileMcpServersFromConfig(ctx.db);
    expect(outcome.updated).toBe(1);

    const rows = await ctx.db.select().from(mcpServers).where(eq(mcpServers.tenant_id, tenantA));
    const row = rows.find((r) => r.namespace === ns);
    expect(row?.name).toBe("New Name MCP");
  });
});

// ── zero-conf tenant ──────────────────────────────────────────────────────────

describe("zero-conf: tenant with no mcp.servers declaration", () => {
  test("outcome 0/0/0 when servers array is empty", async () => {
    // Tenant B has no mcp.servers declared (default = []).
    const cfgPath = join(configDir, "zero-conf.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        tenants: {
          [tenantA]: { mcp: { servers: [] } },
          [tenantB]: { mcp: { servers: [] } },
        },
      }),
    );
    _resetConfigForTests();
    await loadConfig({
      env: { DATABASE_URL: ctx.url, NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });

    const outcome = await reconcileMcpServersFromConfig(ctx.db);
    expect(outcome.inserted).toBe(0);
    expect(outcome.updated).toBe(0);
    // "unchanged" only counts declared+existing matches; 0 declared → 0 unchanged.
    expect(outcome.unchanged).toBe(0);
    expect(outcome.failed).toBe(0);
  });
});

// ── duplicate namespace rejected at parse ───────────────────────────────────────

describe("duplicate namespace within one tenant is a config-validation error", () => {
  test("loadConfig rejects two decls sharing a namespace (no silent clobber)", async () => {
    const dupPath = writeConfigFor([
      {
        name: "First Dup",
        namespace: "dupseed",
        transport: "http",
        url: "https://first.dup.seed.test",
      },
      {
        name: "Second Dup",
        namespace: "dupseed",
        transport: "http",
        url: "https://second.dup.seed.test",
      },
    ]);

    // The duplicate is caught at PARSE time inside loadConfig — it never
    // reaches the reconcile, so there is no last-decl-wins clobber.
    await expect(loadCfg(dupPath)).rejects.toThrow(/duplicate.*namespace.*dupseed/i);
  });

  test("distinct namespaces in the same tenant array parse and seed fine", async () => {
    await loadCfg(
      writeConfigFor([
        {
          name: "Distinct One",
          namespace: "distinctone",
          transport: "http",
          url: "https://one.distinct.seed.test",
        },
        {
          name: "Distinct Two",
          namespace: "distincttwo",
          transport: "http",
          url: "https://two.distinct.seed.test",
        },
      ]),
    );
    const outcome = await reconcileMcpServersFromConfig(ctx.db);
    expect(outcome.inserted).toBe(2);
    expect(outcome.failed).toBe(0);
  });
});

// ── none/null auth normalization ────────────────────────────────────────────────

describe("absent auth vs stored {kind:'none'} are equivalent (idempotency)", () => {
  test("a decl with no auth does not re-update a row stored with {kind:'none'}", async () => {
    const ns = "nonenormseed";

    // Seed a mixed-origin row directly: stored with an explicit
    // auth_config {kind:"none"} (as a CLI/route write would leave it).
    await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "None Norm MCP",
        namespace: ns,
        transport: "http",
        url: "https://nonenorm.seed.test",
        auth_config: { kind: "none" },
      },
      { actor_id: null, request_source: "scheduler" },
    );

    // Config declares the SAME server with NO `auth` block (→ wantAuth=null).
    await loadCfg(
      writeConfigFor([
        {
          name: "None Norm MCP",
          namespace: ns,
          transport: "http",
          url: "https://nonenorm.seed.test",
        },
      ]),
    );

    // Count audit rows before the reconcile to prove nothing is written.
    const beforeAudit = (await ctx.db.select().from(auditLog)).length;

    const outcome = await reconcileMcpServersFromConfig(ctx.db);
    // The mixed-origin row matches the auth-less decl → unchanged, no update.
    expect(outcome.updated).toBe(0);
    expect(outcome.inserted).toBe(0);
    expect(outcome.unchanged).toBe(1);
    expect(outcome.failed).toBe(0);

    const afterAudit = (await ctx.db.select().from(auditLog)).length;
    expect(afterAudit).toBe(beforeAudit);

    // A second re-run is likewise a pure no-op.
    const rerun = await reconcileMcpServersFromConfig(ctx.db);
    expect(rerun.unchanged).toBe(1);
    expect(rerun.updated).toBe(0);
  });
});

// ── audit row written on insert ────────────────────────────────────────────────

describe("audit log", () => {
  test("insert writes mcp_server.registered audit entry", async () => {
    const ns = "auditseed";

    // Count existing audit rows before.
    const before = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "mcp_server.registered"));
    const countBefore = before.length;

    await loadCfg(
      writeConfigFor([
        { name: "Audit MCP", namespace: ns, transport: "http", url: "https://audit.seed.test" },
      ]),
    );
    await reconcileMcpServersFromConfig(ctx.db);

    const after = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "mcp_server.registered"));
    // At least one new audit entry was written.
    expect(after.length).toBeGreaterThan(countBefore);

    const newEntry = after.find(
      (r) => r.tenant_id === tenantA && (r.metadata as Record<string, unknown>)?.namespace === ns,
    );
    expect(newEntry).toBeDefined();
    expect(newEntry?.actor_id).toBeNull(); // system actor
    expect(newEntry?.actor_type).toBe("system");
  });

  test("no-op run writes NO new audit entries", async () => {
    const ns = "noop-audit-seed";
    const decls = [
      {
        name: "Noop Audit MCP",
        namespace: ns,
        transport: "http",
        url: "https://noopaudit.seed.test",
      },
    ];

    await loadCfg(writeConfigFor(decls));
    await reconcileMcpServersFromConfig(ctx.db);

    const before = await ctx.db.select().from(auditLog);
    const countBefore = before.length;

    // Second run — unchanged.
    await loadCfg(writeConfigFor(decls));
    await reconcileMcpServersFromConfig(ctx.db);

    const after = await ctx.db.select().from(auditLog);
    expect(after.length).toBe(countBefore);
  });
});

// ── seeded-but-credential-less operator warning ───────────────────────────────

describe("bearer/oauth2 decl without a credential warns the operator", () => {
  test("seed succeeds AND logger.warn fires with seed.credential_missing", async () => {
    const warnSpy = spyOn(logger, "warn");
    try {
      await loadCfg(
        writeConfigFor([
          {
            name: "Credless Bearer MCP",
            namespace: "credlessseed",
            transport: "http",
            url: "https://credless.seed.test",
            auth: { kind: "bearer" },
          },
        ]),
      );
      const outcome = await reconcileMcpServersFromConfig(ctx.db);
      // The missing credential is a WARNING, never a failure — the row is
      // seeded and the handshake path surfaces the real error later.
      expect(outcome.inserted).toBe(1);
      expect(outcome.failed).toBe(0);

      const fields = warnSpy.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((f) => f.action === "seed.credential_missing" && f.namespace === "credlessseed");
      expect(fields).toBeDefined();
      expect(fields!.module).toBe("mcp.config_seed");
      expect(fields!.tenant_id).toBe(tenantA);
      expect(fields!.auth_kind).toBe("bearer");
      expect(String(fields!.msg)).toContain("sk mcp-servers set-credential");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a re-run with unchanged config stays a no-op (no spurious warn on unchanged rows)", async () => {
    const warnSpy = spyOn(logger, "warn");
    try {
      await loadCfg(
        writeConfigFor([
          {
            name: "Credless Bearer MCP",
            namespace: "credlessseed",
            transport: "http",
            url: "https://credless.seed.test",
            auth: { kind: "bearer" },
          },
        ]),
      );
      const rerun = await reconcileMcpServersFromConfig(ctx.db);
      expect(rerun.unchanged).toBe(1);
      expect(rerun.failed).toBe(0);
      const fired = warnSpy.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .some((f) => f.action === "seed.credential_missing" && f.namespace === "credlessseed");
      // The hint fires on insert/update only — an unchanged row writes
      // nothing and warns nothing (idempotency contract).
      expect(fired).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── multi-tenant fanout ────────────────────────────────────────────────────────

describe("multi-tenant fanout", () => {
  test("each tenant gets its own row; tenant B rows do not appear for tenant A", async () => {
    const cfgPath = join(configDir, "multi-tenant.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        tenants: {
          [tenantA]: {
            mcp: {
              servers: [
                {
                  name: "A-only MCP",
                  namespace: "aonlyseed",
                  transport: "http",
                  url: "https://a.seed.test",
                },
              ],
            },
          },
          [tenantB]: {
            mcp: {
              servers: [
                {
                  name: "B-only MCP",
                  namespace: "bonlyseed",
                  transport: "http",
                  url: "https://b.seed.test",
                },
              ],
            },
          },
        },
      }),
    );
    _resetConfigForTests();
    await loadConfig({
      env: { DATABASE_URL: ctx.url, NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });

    const outcome = await reconcileMcpServersFromConfig(ctx.db);
    expect(outcome.inserted).toBeGreaterThanOrEqual(2);

    const rowsA = await ctx.db.select().from(mcpServers).where(eq(mcpServers.tenant_id, tenantA));
    const rowsB = await ctx.db.select().from(mcpServers).where(eq(mcpServers.tenant_id, tenantB));

    const nsA = rowsA.map((r) => r.namespace);
    const nsB = rowsB.map((r) => r.namespace);

    expect(nsA).toContain("aonlyseed");
    expect(nsA).not.toContain("bonlyseed");
    expect(nsB).toContain("bonlyseed");
    expect(nsB).not.toContain("aonlyseed");
  });
});
