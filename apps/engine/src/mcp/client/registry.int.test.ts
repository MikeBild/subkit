// Registry integration tests for external MCP server CRUD + audit.
//
// Uses a real Postgres database via createTestDb (no mocks). Verifies:
//   - createMcpServer persists a row and emits mcp_server.registered audit.
//   - getMcpServerByNamespace / listMcpServers / listActiveMcpServersForTenant.
//   - updateMcpServer with changed_fields audit (mcp_server.config_updated).
//   - setMcpServerStatus: disabled/re-enabled/errored with matching audit rows.
//   - deleteMcpServer removes the row and emits mcp_server.deleted.
//   - Secret-by-reference: an inline secret key in auth_config is rejected.
//   - bearer auth_config round-trips (kind only; no inline secret).
//   - Tenant isolation: tenant A cannot read/update/delete tenant B's server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  getMcpServerByNamespace,
  listActiveMcpServersForTenant,
  listConnectableMcpServersForTenant,
  listMcpServers,
  type McpServerAuditCtx,
  parseAuthConfig,
  recordMcpServerHandshakeState,
  setMcpServerStatus,
  updateMcpServer,
} from "./registry.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;

// Build the audit context lazily so `executor` uses the test DB.
// This avoids cross-file DATABASE_URL contamination when tests run in
// parallel workers (the fallback getDb() path is not used at all).
function auditCtx(): McpServerAuditCtx {
  return {
    actor_id: "00000000-0000-0000-0000-000000000001",
    request_source: "api",
    executor: ctx.db,
  };
}

beforeAll(async () => {
  ctx = await createTestDb("mcp-registry");

  const [a] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-reg-a", display_name: "Registry Tenant A" })
    .returning();
  const [b] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-reg-b", display_name: "Registry Tenant B" })
    .returning();
  tenantA = a!.id;
  tenantB = b!.id;
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

// ── helpers ──────────────────────────────────────────────────────────────────

async function auditActionsFor(_tenant_id: string, resource_id: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.resource_id, resource_id));
  return rows.map((r) => r.action);
}

// ── createMcpServer ──────────────────────────────────────────────────────────

describe("createMcpServer", () => {
  test("inserts a row with correct fields", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Acme MCP",
        namespace: "acme",
        transport: "http",
        url: "https://mcp.acme.example.com",
      },
      auditCtx(),
    );
    expect(row.id).toBeDefined();
    expect(row.tenant_id).toBe(tenantA);
    expect(row.name).toBe("Acme MCP");
    expect(row.namespace).toBe("acme");
    expect(row.transport).toBe("http");
    expect(row.status).toBe("active");
    expect(row.auth_config).toBeNull();
  });

  test("emits mcp_server.registered audit row", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Audit Test MCP",
        namespace: "auditns",
        transport: "http",
        url: "https://audit.example.com",
      },
      auditCtx(),
    );
    const actions = await auditActionsFor(tenantA, row.id);
    expect(actions).toContain("mcp_server.registered");
  });

  test("bearer auth_config round-trips via parseAuthConfig (no inline secret)", async () => {
    // The bearer secret lives in the credentials table keyed by
    // mcp_server_id — auth_config persists ONLY the kind.
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Bearer MCP",
        namespace: "bearerns",
        transport: "sse",
        url: "https://bearer.example.com",
        auth_config: { kind: "bearer" },
      },
      auditCtx(),
    );
    const parsed = parseAuthConfig(row.auth_config ?? null);
    expect(parsed.kind).toBe("bearer");
    // No secret-by-value key is ever persisted on the row.
    expect(JSON.stringify(row.auth_config)).not.toContain("token");
  });

  test("inline secret key in auth_config is rejected (DB CHECK)", async () => {
    // The mcp_servers_auth_config_no_inline_secrets_check constraint
    // rejects any auth_config with a `client_secret`, `api_key`, etc.
    // Use the pg pool directly to bypass Zod and hit the DB-level constraint.
    const authJson = JSON.stringify({ kind: "bearer", api_key: "SHOULD_BE_REJECTED" });
    await expect(
      ctx.pool.query(
        `INSERT INTO mcp_servers (tenant_id, name, namespace, transport, url, auth_config, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active')`,
        [
          tenantA,
          "Sneaky Secret MCP",
          "sneakysecretns",
          "http",
          "https://evil.example.com",
          authJson,
        ],
      ),
    ).rejects.toThrow();
  });
});

// ── getMcpServerByNamespace ───────────────────────────────────────────────────

describe("getMcpServerByNamespace", () => {
  test("returns the row for the right tenant + namespace", async () => {
    await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Lookup MCP",
        namespace: "lookupns",
        transport: "http",
        url: "https://lookup.example.com",
      },
      auditCtx(),
    );
    const found = await getMcpServerByNamespace(ctx.db, tenantA, "lookupns");
    expect(found).not.toBeNull();
    expect(found!.namespace).toBe("lookupns");
  });

  test("returns null for wrong tenant (isolation)", async () => {
    await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Tenant-A-only",
        namespace: "atenantonly",
        transport: "http",
        url: "https://a-only.example.com",
      },
      auditCtx(),
    );
    // tenant B should NOT see it
    const fromB = await getMcpServerByNamespace(ctx.db, tenantB, "atenantonly");
    expect(fromB).toBeNull();
  });
});

// ── listMcpServers ────────────────────────────────────────────────────────────

describe("listMcpServers", () => {
  test("returns only the calling tenant's rows", async () => {
    // Seed one for A, one for B.
    await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "List A MCP",
        namespace: "listans",
        transport: "http",
        url: "https://list-a.example.com",
      },
      auditCtx(),
    );
    await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantB,
        name: "List B MCP",
        namespace: "listbns",
        transport: "http",
        url: "https://list-b.example.com",
      },
      auditCtx(),
    );

    const aRows = await listMcpServers(ctx.db, tenantA);
    const bRows = await listMcpServers(ctx.db, tenantB);
    const aIds = aRows.map((r) => r.namespace);
    const bIds = bRows.map((r) => r.namespace);
    // A's list must NOT contain B's namespace and vice versa.
    expect(aIds).not.toContain("listbns");
    expect(bIds).not.toContain("listans");
    expect(aIds).toContain("listans");
    expect(bIds).toContain("listbns");
  });
});

// ── updateMcpServer ───────────────────────────────────────────────────────────

describe("updateMcpServer", () => {
  test("updates changed fields and emits config_updated audit", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Update MCP",
        namespace: "updatns",
        transport: "http",
        url: "https://update-before.example.com",
      },
      auditCtx(),
    );

    const updated = await updateMcpServer(
      ctx.db,
      tenantA,
      row.id,
      { url: "https://update-after.example.com", name: "Updated MCP" },
      auditCtx(),
    );

    expect(updated).not.toBeNull();
    expect(updated!.url).toBe("https://update-after.example.com");
    expect(updated!.name).toBe("Updated MCP");

    const actions = await auditActionsFor(tenantA, row.id);
    expect(actions).toContain("mcp_server.config_updated");
  });

  test("no-op update returns existing row without audit", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Noop MCP",
        namespace: "noopns",
        transport: "http",
        url: "https://noop.example.com",
      },
      auditCtx(),
    );

    const priorAudits = await auditActionsFor(tenantA, row.id);
    const priorCount = priorAudits.length;

    // Same values — should be a no-op.
    const result = await updateMcpServer(
      ctx.db,
      tenantA,
      row.id,
      { name: "Noop MCP" }, // unchanged
      auditCtx(),
    );
    expect(result).not.toBeNull();

    const afterAudits = await auditActionsFor(tenantA, row.id);
    // No new audit rows since nothing changed.
    expect(afterAudits.length).toBe(priorCount);
  });

  test("cross-tenant update returns null (isolation)", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Cross-tenant target",
        namespace: "crosstns",
        transport: "http",
        url: "https://cross-tenant.example.com",
      },
      auditCtx(),
    );

    // Tenant B tries to update Tenant A's row — must return null.
    const result = await updateMcpServer(ctx.db, tenantB, row.id, { name: "Hijacked" }, auditCtx());
    expect(result).toBeNull();

    // Row must still have the original name.
    const unchanged = await getMcpServer(ctx.db, tenantA, row.id);
    expect(unchanged!.name).toBe("Cross-tenant target");
  });
});

// ── setMcpServerStatus ────────────────────────────────────────────────────────

describe("setMcpServerStatus", () => {
  test("active → disabled emits mcp_server.disabled audit", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Disable MCP",
        namespace: "disabns",
        transport: "http",
        url: "https://disable.example.com",
      },
      auditCtx(),
    );

    const result = await setMcpServerStatus(ctx.db, tenantA, row.id, "disabled", auditCtx());
    expect(result).not.toBeNull();
    expect(result!.status).toBe("disabled");

    const actions = await auditActionsFor(tenantA, row.id);
    expect(actions).toContain("mcp_server.disabled");
  });

  test("disabled → active emits mcp_server.re_enabled audit", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "ReEnable MCP",
        namespace: "reenns",
        transport: "http",
        url: "https://re-enable.example.com",
      },
      auditCtx(),
    );
    // First disable.
    await setMcpServerStatus(ctx.db, tenantA, row.id, "disabled", auditCtx());
    // Then re-enable.
    const result = await setMcpServerStatus(ctx.db, tenantA, row.id, "active", auditCtx());
    expect(result!.status).toBe("active");

    const actions = await auditActionsFor(tenantA, row.id);
    expect(actions).toContain("mcp_server.re_enabled");
  });

  test("error status emits mcp_server.errored with last_error", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Error MCP",
        namespace: "errorns",
        transport: "http",
        url: "https://error.example.com",
      },
      auditCtx(),
    );

    const result = await setMcpServerStatus(ctx.db, tenantA, row.id, "error", auditCtx(), {
      last_error: "connection refused",
    });
    expect(result!.status).toBe("error");
    expect(result!.last_error).toBe("connection refused");

    const actions = await auditActionsFor(tenantA, row.id);
    expect(actions).toContain("mcp_server.errored");
  });

  test("cross-tenant status change returns null (isolation)", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Cross-Tenant Disable",
        namespace: "ctdisabns",
        transport: "http",
        url: "https://ct-disable.example.com",
      },
      auditCtx(),
    );

    const result = await setMcpServerStatus(ctx.db, tenantB, row.id, "disabled", auditCtx());
    expect(result).toBeNull();

    // Row must still be active for tenant A.
    const unchanged = await getMcpServer(ctx.db, tenantA, row.id);
    expect(unchanged!.status).toBe("active");
  });
});

// ── deleteMcpServer ───────────────────────────────────────────────────────────

describe("deleteMcpServer", () => {
  test("deletes the row and emits mcp_server.deleted audit", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Delete MCP",
        namespace: "deletns",
        transport: "http",
        url: "https://delete.example.com",
      },
      auditCtx(),
    );

    const deleted = await deleteMcpServer(ctx.db, tenantA, row.id, auditCtx());
    expect(deleted).toBe(true);

    // Row is gone.
    const gone = await getMcpServer(ctx.db, tenantA, row.id);
    expect(gone).toBeNull();

    // Audit row for deleted — read from all audit rows (resource_id won't exist).
    const actions = await auditActionsFor(tenantA, row.id);
    expect(actions).toContain("mcp_server.deleted");
  });

  test("cross-tenant delete returns false (isolation)", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "CT Delete MCP",
        namespace: "ctdeletns",
        transport: "http",
        url: "https://ct-delete.example.com",
      },
      auditCtx(),
    );

    // Tenant B attempts to delete Tenant A's row.
    const result = await deleteMcpServer(ctx.db, tenantB, row.id, auditCtx());
    expect(result).toBe(false);

    // Row still exists for tenant A.
    const still = await getMcpServer(ctx.db, tenantA, row.id);
    expect(still).not.toBeNull();
  });

  test("double-delete returns false (idempotent)", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Double Delete MCP",
        namespace: "deldel",
        transport: "http",
        url: "https://double-delete.example.com",
      },
      auditCtx(),
    );

    const first = await deleteMcpServer(ctx.db, tenantA, row.id, auditCtx());
    expect(first).toBe(true);
    const second = await deleteMcpServer(ctx.db, tenantA, row.id, auditCtx());
    expect(second).toBe(false);
  });
});

// ── listActiveMcpServersForTenant ─────────────────────────────────────────────

describe("listActiveMcpServersForTenant", () => {
  test("only returns active rows, not disabled or error", async () => {
    const active = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Active MCP",
        namespace: "activens",
        transport: "http",
        url: "https://active.example.com",
      },
      auditCtx(),
    );
    const disabled = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Disabled MCP",
        namespace: "disabledns",
        transport: "http",
        url: "https://disabled.example.com",
      },
      auditCtx(),
    );
    await setMcpServerStatus(ctx.db, tenantA, disabled.id, "disabled", auditCtx());

    const rows = await listActiveMcpServersForTenant(ctx.db, tenantA);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(disabled.id);
  });
});

// ── listConnectableMcpServersForTenant (error-status recovery) ─────────────────

describe("listConnectableMcpServersForTenant", () => {
  test("returns active AND error rows but never disabled", async () => {
    const active = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Connectable Active",
        namespace: "connactive",
        transport: "http",
        url: "https://conn-active.example.com",
      },
      auditCtx(),
    );
    const errored = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Connectable Errored",
        namespace: "connerror",
        transport: "http",
        url: "https://conn-error.example.com",
      },
      auditCtx(),
    );
    const disabled = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Connectable Disabled",
        namespace: "conndisabled",
        transport: "http",
        url: "https://conn-disabled.example.com",
      },
      auditCtx(),
    );
    await setMcpServerStatus(ctx.db, tenantA, errored.id, "error", auditCtx(), {
      last_error: "boom",
    });
    await setMcpServerStatus(ctx.db, tenantA, disabled.id, "disabled", auditCtx());

    const ids = (await listConnectableMcpServersForTenant(ctx.db, tenantA)).map((r) => r.id);
    // An error-status server is still connectable (retry past backoff) so it
    // is never permanently dark; a disabled one stays out.
    expect(ids).toContain(active.id);
    expect(ids).toContain(errored.id);
    expect(ids).not.toContain(disabled.id);
  });
});

// ── SSRF egress guard at registration ─────────────────────────────────────────

describe("createMcpServer egress guard", () => {
  test("rejects a loopback / metadata URL at registration", async () => {
    // The egress guard runs after Zod parse; in non-production (permissive)
    // mode a bare localhost / unspecified address is still blocked.
    await expect(
      createMcpServer(
        ctx.db,
        {
          tenant_id: tenantA,
          name: "SSRF MCP",
          namespace: "ssrfns",
          transport: "http",
          url: "http://localhost:9000/mcp",
        },
        auditCtx(),
      ),
    ).rejects.toThrow();
  });
});

// ── last_error redaction ──────────────────────────────────────────────────────

describe("setMcpServerStatus last_error redaction", () => {
  test("strips URL query/path from a persisted last_error", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Redact MCP",
        namespace: "redactns",
        transport: "http",
        url: "https://redact.example.com",
      },
      auditCtx(),
    );
    await setMcpServerStatus(ctx.db, tenantA, row.id, "error", auditCtx(), {
      last_error: "fetch https://redact.example.com/call?token=LEAKED_SECRET failed",
    });
    const after = await getMcpServer(ctx.db, tenantA, row.id);
    expect(after!.last_error).not.toContain("LEAKED_SECRET");
    expect(after!.last_error).not.toContain("?token");
    expect(after!.last_error).toContain("https://redact.example.com");
  });
});

// ── recordMcpServerHandshakeState — auto-recovery audit ────────────────────

describe("recordMcpServerHandshakeState auto-recovery audit", () => {
  test("error → active flip emits mcp_server.re_enabled with reason auto_recovered_via_handshake", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Recover MCP",
        namespace: "recoverns",
        transport: "http",
        url: "https://recover.example.com",
      },
      auditCtx(),
    );
    // Park it in error first (the prior state the recovery edge fires on).
    await setMcpServerStatus(ctx.db, tenantA, row.id, "error", auditCtx(), {
      last_error: "transient handshake failure",
    });

    // A successful handshake recovers it to active — this MUST audit the edge.
    const recovered = await recordMcpServerHandshakeState(
      ctx.db,
      tenantA,
      row.id,
      "sha256:recovered-hash",
      auditCtx(),
    );
    expect(recovered!.status).toBe("active");
    expect(recovered!.tools_manifest_hash).toBe("sha256:recovered-hash");

    const reEnabledRows = await ctx.db
      .select({ action: auditLog.action, reason: auditLog.reason })
      .from(auditLog)
      .where(eq(auditLog.resource_id, row.id));
    const reEnabled = reEnabledRows.filter((r) => r.action === "mcp_server.re_enabled");
    expect(reEnabled.length).toBe(1);
    expect(reEnabled[0]!.reason).toBe("auto_recovered_via_handshake");
  });

  test("concurrent handshakes on one errored server emit exactly ONE re_enabled row", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Race MCP",
        namespace: "racens",
        transport: "http",
        url: "https://race.example.com",
      },
      auditCtx(),
    );
    await setMcpServerStatus(ctx.db, tenantA, row.id, "error", auditCtx(), {
      last_error: "transient handshake failure",
    });

    // The prior status is captured atomically inside the UPDATE (FOR UPDATE
    // subselect): the second caller blocks on the row lock and re-reads the
    // already-recovered status, so only one caller observes `error`.
    await Promise.all([
      recordMcpServerHandshakeState(ctx.db, tenantA, row.id, "sha256:race-a", auditCtx()),
      recordMcpServerHandshakeState(ctx.db, tenantA, row.id, "sha256:race-b", auditCtx()),
    ]);

    const reEnabledRows = await ctx.db
      .select({ action: auditLog.action, reason: auditLog.reason })
      .from(auditLog)
      .where(eq(auditLog.resource_id, row.id));
    const reEnabled = reEnabledRows.filter((r) => r.action === "mcp_server.re_enabled");
    expect(reEnabled.length).toBe(1);
    expect(reEnabled[0]!.reason).toBe("auto_recovered_via_handshake");
  });

  test("active → active handshake does NOT emit a re_enabled row (no spurious recovery audit)", async () => {
    const row = await createMcpServer(
      ctx.db,
      {
        tenant_id: tenantA,
        name: "Steady MCP",
        namespace: "steadyns",
        transport: "http",
        url: "https://steady.example.com",
      },
      auditCtx(),
    );
    // Row is created `active`; a handshake from active must not re-enable.
    await recordMcpServerHandshakeState(ctx.db, tenantA, row.id, "sha256:steady", auditCtx());

    const actions = await auditActionsFor(tenantA, row.id);
    expect(actions).not.toContain("mcp_server.re_enabled");
  });
});
