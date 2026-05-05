// Integration test for /v1/settings — DB-backed via testcontainers,
// real Hono app, real config-loader bootstrap.
//
// Covers the v3.5 wire contract:
//   - GET /v1/settings returns the effective tree + diagnostics
//   - PUT /v1/settings/{path} returns 200 { value, requiresRestart }
//   - PUT validation failure returns 422 { code, message, path, expected }
//   - PUT requires-restart in production returns 409
//   - PUT scope_violation (global leaf with ?tenant) returns 403
//   - Audit row carries the target tenant_id for ?tenant=X writes
//   - Cross-tenant guard rejects non-admin callers targeting other tenants

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { apiKeys, tenants, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let cfgDir: string;

beforeAll(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-route-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/route-test", NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  server = await createHttpTestServer("settings-route");
});

afterAll(async () => {
  await server.cleanup();
  _resetConfigForTests();
  rmSync(cfgDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await server.db.delete(auditLog);
});

interface PutResult {
  value: unknown;
  requiresRestart: boolean;
}

interface ValidationFailure {
  code: "validation_failed";
  message: string;
  path: string[];
  expected: string;
}

interface ScopeViolation {
  code: "scope_violation";
  message: string;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${server.apiKey}`,
      ...(init.headers ?? {}),
    },
  });
}

describe("GET /v1/settings", () => {
  test("returns the effective config tree with diagnostics", async () => {
    const res = await authedFetch("/v1/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ path: string; value: unknown; meta: Record<string, unknown> }>;
      diagnostics: { pending_restart_keys: string[]; override_keys: string[] };
    };
    expect(body.items.length).toBeGreaterThan(50);
    expect(body.diagnostics).toBeDefined();
    const llmKey = body.items.find((i) => i.path === "llm.api_key");
    expect(llmKey).toBeDefined();
    expect(llmKey!.meta.sensitive).toBe(true);
    expect(llmKey!.meta.scope).toBe("tenant");
  });
});

describe("GET /v1/settings/{path}", () => {
  test("returns one leaf with its meta", async () => {
    const res = await authedFetch("/v1/settings/log.level");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      value: unknown;
      meta: { kind: string; sensitive: boolean; scope: string };
    };
    expect(body.path).toBe("log.level");
    expect(body.value).toBe("info");
    expect(body.meta.kind).toBe("enum");
    expect(body.meta.sensitive).toBe(false);
  });

  test("unknown path returns 404", async () => {
    const res = await authedFetch("/v1/settings/does.not.exist");
    expect(res.status).toBe(404);
  });
});

describe("PUT /v1/settings/{path}", () => {
  test("happy path returns 200 + audit row tagged with the actor", async () => {
    const res = await authedFetch("/v1/settings/llm.api_key", {
      method: "PUT",
      body: JSON.stringify({ value: "sk-test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PutResult;
    expect(body.requiresRestart).toBe(false);
    // Sensitive leaf — value comes back masked.
    expect(body.value).toBe("***");

    const rows = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.actor_id).toBe(server.userId);
    expect(row.resource_type).toBe("setting");
    expect(row.resource_id).toBe("llm.api_key");
    // Masked diff is the primitive value (matches audit_log convention).
    // Never a raw secret.
    expect(JSON.stringify(row.after)).not.toContain("sk-test");
    expect(row.after).toBe("***");
  });

  test("validation failure returns 422 with path + expected", async () => {
    const res = await authedFetch("/v1/settings/log.level", {
      method: "PUT",
      body: JSON.stringify({ value: "bogus" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationFailure;
    expect(body.code).toBe("validation_failed");
    expect(body.path[0]).toBe("log");
    expect(typeof body.expected).toBe("string");
  });

  test("scope_violation when ?tenant is set on a global leaf", async () => {
    const res = await authedFetch(`/v1/settings/server.port?tenant=${server.tenantId}`, {
      method: "PUT",
      body: JSON.stringify({ value: 4000 }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ScopeViolation;
    expect(body.code).toBe("scope_violation");
  });

  test("tenant-overlay write succeeds + audit tenant_id matches the target", async () => {
    const res = await authedFetch(`/v1/settings/llm.api_key?tenant=${server.tenantId}`, {
      method: "PUT",
      body: JSON.stringify({ value: "tenant-key" }),
    });
    expect(res.status).toBe(200);
    const rows = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tenant_id).toBe(server.tenantId);
    expect(rows[0]!.actor_id).toBe(server.userId);
  });

  test("unknown path returns 404, no audit row written", async () => {
    const res = await authedFetch("/v1/settings/does.not.exist", {
      method: "PUT",
      body: JSON.stringify({ value: 1 }),
    });
    expect(res.status).toBe(404);
    const rows = await server.db.select().from(auditLog);
    expect(rows.length).toBe(0);
  });

  test("requires-restart in production returns 409 + envelope shape (without force)", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await authedFetch("/v1/settings/server.port", {
        method: "PUT",
        body: JSON.stringify({ value: 4001 }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        code: string;
        message: string;
        requiresRestart: boolean;
      };
      expect(body.code).toBe("restart_required");
      expect(body.requiresRestart).toBe(true);
      expect(typeof body.message).toBe("string");
      const rows = await server.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.changed"));
      expect(rows.length).toBe(0); // 409 before commit → no audit row
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  test("requires-restart in production with force=true returns 200 + audit row", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await authedFetch("/v1/settings/server.port", {
        method: "PUT",
        body: JSON.stringify({ value: 4001, force: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { value: unknown; requiresRestart: boolean };
      expect(body.requiresRestart).toBe(true);
      const rows = await server.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.changed"));
      expect(rows.length).toBe(1);
      const meta = rows[0]!.metadata as Record<string, unknown>;
      expect(meta.force_applied).toBe(true);
      expect(meta.requires_restart).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  test("non-admin caller cannot mutate another tenant's overlay", async () => {
    // Seed a separate tenant + a non-admin user + api key in that
    // tenant. The cross-tenant guard expects either a same-tenant
    // target OR `principal.roles.includes("admin")`.
    const [otherTenant] = await server.db
      .insert(tenants)
      .values({ slug: `other-${Date.now()}`, display_name: "Other Tenant" })
      .returning();
    const [otherUser] = await server.db
      .insert(users)
      .values({
        tenant_id: otherTenant!.id,
        email: `member-${Date.now()}@test.local`,
        role: "member",
      })
      .returning();
    const plaintext = `wf_live_${randomBytes(24).toString("base64url").slice(0, 32)}`;
    await server.db.insert(apiKeys).values({
      tenant_id: otherTenant!.id,
      user_id: otherUser!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: createHash("sha256").update(plaintext).digest("hex"),
      scopes: ["*"],
    });

    // The non-admin tenant tries to PUT against `server.tenantId`.
    const res = await fetch(`${server.baseUrl}/v1/settings/llm.api_key?tenant=${server.tenantId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${plaintext}`,
      },
      body: JSON.stringify({ value: "stolen" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("scope_violation");
    const rows = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    expect(rows.length).toBe(0);
  });

  test("source_map and live value reflect every layer of the precedence chain", async () => {
    // 1. Default — fresh boot, no overrides, no writes. ring_size
    //    starts at the schema default (100).
    let res = await authedFetch("/v1/settings/errors.ring_size");
    let body = (await res.json()) as { value: unknown; meta: { source: string } };
    expect(body.value).toBe(100);
    expect(body.meta.source).toBe("default");

    // 2. Global write — flips the leaf to source:"global".
    await authedFetch("/v1/settings/errors.ring_size", {
      method: "PUT",
      body: JSON.stringify({ value: 250 }),
    });
    res = await authedFetch("/v1/settings/errors.ring_size");
    body = (await res.json()) as { value: unknown; meta: { source: string } };
    expect(body.value).toBe(250);
    expect(body.meta.source).toBe("global");

    // 3. List shows the diagnostics tally honoring the new source.
    const listRes = await authedFetch("/v1/settings");
    const list = (await listRes.json()) as {
      items: Array<{ path: string; meta: { source: string } }>;
    };
    const ring = list.items.find((i) => i.path === "errors.ring_size");
    expect(ring!.meta.source).toBe("global");
  });

  test("audit row carries actor_tenant_id (resolved from principal context)", async () => {
    // The audit module fills tenant_id from the entry. We pass the
    // target tenant explicitly. The actor's tenant_id is recoverable
    // from the trace_id → request log; v3.6 will add a dedicated
    // `actor_tenant_id` column. For v3.5, the contract is that the
    // row's tenant_id is the *target* tenant (where the change
    // applies), and actor_id alone identifies the principal.
    const res = await authedFetch(`/v1/settings/llm.api_key?tenant=${server.tenantId}`, {
      method: "PUT",
      body: JSON.stringify({ value: "audit-id-test" }),
    });
    expect(res.status).toBe(200);
    const rows = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tenant_id).toBe(server.tenantId);
    expect(rows[0]!.actor_id).toBe(server.userId);
    expect(rows[0]!.actor_type).toBe("user");
  });
});
