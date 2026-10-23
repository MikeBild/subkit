import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { SYSTEM_TENANT_ID } from "../../../audit/index.ts";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { apiKeys, systemAccounts, tenants, users } from "../../../db/schema/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

const det = createDeterministicHexFactory(0xc0ffee);
let seq = 0;
function nextSeq(): string {
  seq += 1;
  return seq.toString(36).padStart(4, "0");
}

let server: HttpTestServer;
let cfgDir: string;

beforeAll(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-route-"));
  _resetConfigForTests();
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/route-test",
      NODE_ENV: "test",
    },
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
      items: Array<{
        path: string;
        value: unknown;
        meta: Record<string, unknown>;
      }>;
      diagnostics: { pending_restart_keys: string[]; override_keys: string[] };
    };
    expect(body.items.length).toBeGreaterThan(50);
    expect(body.diagnostics).toBeDefined();
    const llmKey = body.items.find((i) => i.path === "llm.api_key");
    expect(llmKey).toBeDefined();
    expect(llmKey!.meta.sensitive).toBe(true);
    expect(llmKey!.meta.scope).toBe("tenant");
    const authProviders = body.items.find((i) => i.path === "auth.providers");
    expect(authProviders).toBeDefined();
    expect(authProviders!.meta).toMatchObject({
      kind: "json",
      sensitive: false,
      requiresRestart: false,
      scope: "global",
    });
    const logLevel = body.items.find((i) => i.path === "log.level");
    expect(logLevel!.meta.default).toBe("info");
    expect(logLevel!.meta.enum_values).toEqual([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ]);
    const budget = body.items.find((i) => i.path === "tokens.monthly_budget");
    expect(budget!.meta.default).toBe(0);
    expect(budget!.meta).not.toHaveProperty("enum_values");
    const fallback = body.items.find((i) => i.path === "llm.fallback_provider");
    expect(fallback!.meta).toHaveProperty("default", null);
    const database = body.items.find((i) => i.path === "database.url");
    expect(database!.meta).not.toHaveProperty("default");
  });

  test("tenant source metadata is scoped to the requested tenant", async () => {
    const path = "tokens.monthly_budget";
    const put = await authedFetch(`/v1/settings/${path}?tenant=${server.tenantId}`, {
      method: "PUT",
      body: JSON.stringify({ value: 123 }),
    });
    expect(put.status).toBe(200);

    const globalRes = await authedFetch(`/v1/settings/${path}`);
    expect(globalRes.status).toBe(200);
    const globalBody = (await globalRes.json()) as {
      value: unknown;
      meta: { source: string };
    };
    expect(globalBody.value).toBe(0);
    expect(globalBody.meta.source).toBe("default");

    const tenantRes = await authedFetch(`/v1/settings/${path}?tenant=${server.tenantId}`);
    expect(tenantRes.status).toBe(200);
    const tenantBody = (await tenantRes.json()) as {
      value: unknown;
      meta: { source: string };
    };
    expect(tenantBody.value).toBe(123);
    expect(tenantBody.meta.source).toBe("tenant");
  });

  test("cross-tenant read rejects non-admin callers", async () => {
    const seqTag = nextSeq();
    const [otherTenant] = await server.db
      .insert(tenants)
      .values({ slug: `reader-${seqTag}`, display_name: "Reader Tenant" })
      .returning();
    const [otherUser] = await server.db
      .insert(users)
      .values({
        tenant_id: otherTenant!.id,
        email: `reader-${seqTag}@test.local`,
        role_id: await builtinRoleId(server.db, "member"),
      })
      .returning();
    const plaintext = `wf_live_${det(16)}`;
    await server.db.insert(apiKeys).values({
      tenant_id: otherTenant!.id,
      user_id: otherUser!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: createHash("sha256").update(plaintext).digest("hex"),
      scopes: ["*"],
    });

    const res = await fetch(`${server.baseUrl}/v1/settings?tenant=${server.tenantId}`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(403);
    const leafRes = await fetch(
      `${server.baseUrl}/v1/settings/tokens.monthly_budget?tenant=${server.tenantId}`,
      { headers: { authorization: `Bearer ${plaintext}` } },
    );
    expect(leafRes.status).toBe(403);
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
    expect(body.meta).toMatchObject({
      default: "info",
      enum_values: ["trace", "debug", "info", "warn", "error", "fatal"],
    });
  });

  test("unknown path returns 404", async () => {
    const res = await authedFetch("/v1/settings/does.not.exist");
    expect(res.status).toBe(404);
  });

  test("object-store credentials render masked when set", async () => {
    await authedFetch("/v1/settings/storage.object_store.access_key_id", {
      method: "PUT",
      body: JSON.stringify({ value: "actual-access-key" }),
    });
    await authedFetch("/v1/settings/storage.object_store.secret_access_key", {
      method: "PUT",
      body: JSON.stringify({ value: "actual-secret-key" }),
    });

    const ak = await authedFetch("/v1/settings/storage.object_store.access_key_id");
    const akBody = (await ak.json()) as {
      value: unknown;
      meta: { sensitive: boolean };
    };
    expect(akBody.value).toBe("***");
    expect(akBody.meta.sensitive).toBe(true);

    const sk = await authedFetch("/v1/settings/storage.object_store.secret_access_key");
    const skBody = (await sk.json()) as {
      value: unknown;
      meta: { sensitive: boolean };
    };
    expect(skBody.value).toBe("***");
    expect(skBody.meta.sensitive).toBe(true);

    const listRes = await authedFetch("/v1/settings");
    const list = (await listRes.json()) as {
      items: Array<{
        path: string;
        value: unknown;
        meta: { sensitive: boolean };
      }>;
    };
    const akEntry = list.items.find((i) => i.path === "storage.object_store.access_key_id");
    const skEntry = list.items.find((i) => i.path === "storage.object_store.secret_access_key");
    expect(akEntry!.value).toBe("***");
    expect(skEntry!.value).toBe("***");
    const blob = JSON.stringify(list);
    expect(blob).not.toContain("actual-access-key");
    expect(blob).not.toContain("actual-secret-key");
  });
});

describe("PUT /v1/settings/{path}", () => {
  test("fallback settings audit preserves system-account actor kind", async () => {
    await server.db
      .update(systemAccounts)
      .set({ role_id: await builtinRoleId(server.db, "admin") })
      .where(eq(systemAccounts.id, server.systemAccountId));
    const machineKey = "wf_live_SYS_settings_actor_fallback_000";
    await server.db.insert(apiKeys).values({
      tenant_id: server.tenantId,
      system_account_id: server.systemAccountId,
      prefix: machineKey.slice(0, 12),
      token_sha256: createHash("sha256").update(machineKey).digest("hex"),
      scopes: ["*"],
    });

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const response = await fetch(
        `${server.baseUrl}/v1/settings/tokens.monthly_budget?tenant=${server.tenantId}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${machineKey}`,
          },
          body: JSON.stringify({ value: 100 }),
        },
      );
      expect(response.status).toBe(200);

      const [audit] = await server.db
        .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
        .from(auditLog)
        .where(eq(auditLog.action, "settings.changed"));
      expect(audit).toEqual({ actor_type: "system_account", actor_id: server.systemAccountId });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  test("OIDC providers apply hot and remain private", async () => {
    const providers = [
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
      {
        protocol: "oidc",
        id: "workforce",
        label: "Workforce SSO",
        issuer_url: "https://identity.example.test",
        client_id: "subkit-test-client",
        scopes: "openid profile email",
        tenant_slug: "default",
      },
    ];
    const res = await authedFetch("/v1/settings/auth.providers", {
      method: "PUT",
      body: JSON.stringify({ value: providers }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as PutResult).toEqual({
      value: providers,
      requiresRestart: false,
    });

    const anonymous = await fetch(`${server.baseUrl}/v1/identity/providers`);
    expect(anonymous.status).toBe(200);
    const discovery = await authedFetch("/v1/identity/providers");
    expect(discovery.status).toBe(200);
    const expected = {
      providers: [
        { protocol: "oidc", id: "workforce", label: "SSO" },
        { protocol: "api_key", id: "api-key", label: "API key" },
      ],
    };
    const anonymousBody = (await anonymous.json()) as Record<string, unknown>;
    expect(anonymousBody).toEqual(expected);
    expect((await discovery.json()) as Record<string, unknown>).toEqual(expected);
    expect(JSON.stringify(anonymousBody)).not.toContain("Workforce");
  });

  test("confidential OIDC secrets are rejected instead of persisted", async () => {
    const res = await authedFetch("/v1/settings/auth.providers", {
      method: "PUT",
      body: JSON.stringify({
        value: [
          {
            protocol: "oidc",
            id: "confidential",
            label: "Confidential",
            issuer_url: "https://identity.example.test",
            client_id: "client",
            client_secret: "must-not-be-stored",
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain("must-not-be-stored");
  });

  test("happy path returns 200 + audit row tagged with the actor", async () => {
    const res = await authedFetch("/v1/settings/llm.api_key", {
      method: "PUT",
      body: JSON.stringify({ value: "sk-test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PutResult;
    expect(body.requiresRestart).toBe(false);
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
      expect(rows.length).toBe(0);
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
      const body = (await res.json()) as {
        value: unknown;
        requiresRestart: boolean;
      };
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
    const seqTag = nextSeq();
    const [otherTenant] = await server.db
      .insert(tenants)
      .values({ slug: `other-${seqTag}`, display_name: "Other Tenant" })
      .returning();
    const [otherUser] = await server.db
      .insert(users)
      .values({
        tenant_id: otherTenant!.id,
        email: `member-${seqTag}@test.local`,
        role_id: await builtinRoleId(server.db, "member"),
      })
      .returning();
    const plaintext = `wf_live_${det(16)}`;
    await server.db.insert(apiKeys).values({
      tenant_id: otherTenant!.id,
      user_id: otherUser!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: createHash("sha256").update(plaintext).digest("hex"),
      scopes: ["*"],
    });

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

  test("a tenant admin cannot mutate another tenant's overlay", async () => {
    const seqTag = nextSeq();
    const [otherTenant] = await server.db
      .insert(tenants)
      .values({ slug: `admin-other-${seqTag}`, display_name: "Other Tenant" })
      .returning();
    const [adminUser] = await server.db
      .insert(users)
      .values({
        tenant_id: otherTenant!.id,
        email: `admin-${seqTag}@test.local`,
        role_id: await builtinRoleId(server.db, "admin"),
      })
      .returning();
    const plaintext = `wf_live_${det(16)}`;
    await server.db.insert(apiKeys).values({
      tenant_id: otherTenant!.id,
      user_id: adminUser!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: createHash("sha256").update(plaintext).digest("hex"),
      scopes: ["*"],
    });

    const res = await fetch(`${server.baseUrl}/v1/settings/llm.api_key?tenant=${server.tenantId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${plaintext}`,
      },
      body: JSON.stringify({ value: "stolen-by-tenant-admin" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("scope_violation");
  });

  test("the engine operator can mutate another tenant's overlay; the system tenant cannot", async () => {
    const seqTag = nextSeq();
    const [otherTenant] = await server.db
      .insert(tenants)
      .values({ slug: `operated-${seqTag}`, display_name: "Operated Tenant" })
      .returning();
    const res = await fetch(`${server.baseUrl}/v1/settings/llm.api_key?tenant=${otherTenant!.id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.apiKey}`,
      },
      body: JSON.stringify({ value: "set-by-engine-operator" }),
    });
    expect(res.status).toBe(200);

    await server.db
      .insert(tenants)
      .values({
        id: SYSTEM_TENANT_ID,
        slug: `system-${seqTag}`,
        display_name: "System",
      })
      .onConflictDoNothing();
    const [sysAdmin] = await server.db
      .insert(users)
      .values({
        tenant_id: SYSTEM_TENANT_ID,
        email: `sysop-${seqTag}@test.local`,
        role_id: await builtinRoleId(server.db, "admin"),
      })
      .returning();
    const plaintext = `wf_live_${det(16)}`;
    await server.db.insert(apiKeys).values({
      tenant_id: SYSTEM_TENANT_ID,
      user_id: sysAdmin!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: createHash("sha256").update(plaintext).digest("hex"),
      scopes: ["*"],
    });
    const system = await fetch(
      `${server.baseUrl}/v1/settings/llm.api_key?tenant=${server.tenantId}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${plaintext}`,
        },
        body: JSON.stringify({ value: "set-by-system-tenant" }),
      },
    );
    expect(system.status).toBe(403);
    expect(((await system.json()) as { code: string }).code).toBe("scope_violation");
  });

  test("cross-tenant guard rejects writes to repl/ui/notifications overlays", async () => {
    const seqTag = nextSeq();
    const [otherTenant] = await server.db
      .insert(tenants)
      .values({ slug: `overlay-${seqTag}`, display_name: "Overlay Tenant" })
      .returning();
    const [otherUser] = await server.db
      .insert(users)
      .values({
        tenant_id: otherTenant!.id,
        email: `overlay-member-${seqTag}@test.local`,
        role_id: await builtinRoleId(server.db, "member"),
      })
      .returning();
    const plaintext = `wf_live_${det(16)}`;
    await server.db.insert(apiKeys).values({
      tenant_id: otherTenant!.id,
      user_id: otherUser!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: createHash("sha256").update(plaintext).digest("hex"),
      scopes: ["*"],
    });

    const targets: Array<[string, unknown]> = [
      ["repl.permissionMode", "yolo"],
      ["ui.theme", "dark"],
      ["ui.personality", "verbose"],
      ["notifications.push.enabled", true],
      ["notifications.push.thresholdSec", 5],
    ];

    for (const [path, value] of targets) {
      const res = await fetch(`${server.baseUrl}/v1/settings/${path}?tenant=${server.tenantId}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${plaintext}`,
        },
        body: JSON.stringify({ value }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("scope_violation");
    }

    const rows = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.changed"));
    expect(rows.length).toBe(0);
  });

  test("source_map and live value reflect every layer of the precedence chain", async () => {
    let res = await authedFetch("/v1/settings/errors.ring_size");
    let body = (await res.json()) as {
      value: unknown;
      meta: { source: string };
    };
    expect(body.value).toBe(100);
    expect(body.meta.source).toBe("default");

    await authedFetch("/v1/settings/errors.ring_size", {
      method: "PUT",
      body: JSON.stringify({ value: 250 }),
    });
    res = await authedFetch("/v1/settings/errors.ring_size");
    body = (await res.json()) as { value: unknown; meta: { source: string } };
    expect(body.value).toBe(250);
    expect(body.meta.source).toBe("global");

    const listRes = await authedFetch("/v1/settings");
    const list = (await listRes.json()) as {
      items: Array<{ path: string; meta: { source: string } }>;
    };
    const ring = list.items.find((i) => i.path === "errors.ring_size");
    expect(ring!.meta.source).toBe("global");
  });

  test("non-restart leaf returns requiresRestart:false explicitly", async () => {
    const res = await authedFetch("/v1/settings/log.level", {
      method: "PUT",
      body: JSON.stringify({ value: "debug" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PutResult;
    expect(body.requiresRestart).toBe(false);
    expect(typeof body.requiresRestart).toBe("boolean");
  });

  test("pending_restart_keys deduplicates repeat writes to the same leaf", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await authedFetch("/v1/settings/server.port", {
        method: "PUT",
        body: JSON.stringify({ value: 4010, force: true }),
      });
      await authedFetch("/v1/settings/server.port", {
        method: "PUT",
        body: JSON.stringify({ value: 4011, force: true }),
      });

      const list = await authedFetch("/v1/settings");
      const body = (await list.json()) as {
        diagnostics: { pending_restart_keys: string[] };
      };
      const keys = body.diagnostics.pending_restart_keys;
      const matching = keys.filter((k) => k === "server.port");
      expect(matching.length).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  test("audit row carries actor_tenant_id (resolved from principal context)", async () => {
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

describe("GET /v1/settings/catalog/models", () => {
  interface CatalogBody {
    currency: string;
    models: Array<{
      model: string;
      provider: string | null;
      display_name: string;
      price_source: string;
      input_per_mtok: number;
      badges: { recommended: boolean };
    }>;
  }

  async function memberKey(tenantId: string, scopes: string[]): Promise<string> {
    const seqTag = nextSeq();
    const [member] = await server.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: `catalog-${seqTag}@test.local`,
        role_id: await builtinRoleId(server.db, "member"),
      })
      .returning();
    const plaintext = `wf_live_${det(16)}`;
    await server.db.insert(apiKeys).values({
      tenant_id: tenantId,
      user_id: member!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: createHash("sha256").update(plaintext).digest("hex"),
      scopes,
    });
    return plaintext;
  }

  test("returns the named model catalog instead of an unknown setting path", async () => {
    const res = await authedFetch("/v1/settings/catalog/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogBody;
    expect(body.currency).toBe("USD");
    expect(body.models.find((m) => m.model === "gpt-4.1-mini")).toMatchObject({
      provider: "openai",
      display_name: "GPT-4.1 mini",
      price_source: "catalog",
      badges: { recommended: true },
    });
  });

  test("rejects a request without authentication", async () => {
    const res = await fetch(`${server.baseUrl}/v1/settings/catalog/models`);
    expect(res.status).toBe(401);
  });

  test("rejects a principal without settings:read", async () => {
    const key = await memberKey(server.tenantId, ["workflows:read"]);
    const res = await fetch(`${server.baseUrl}/v1/settings/catalog/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
  });

  test("another workspace's price override stays in that workspace", async () => {
    const seqTag = nextSeq();
    const [otherTenant] = await server.db
      .insert(tenants)
      .values({ slug: `catalog-${seqTag}`, display_name: "Catalog Tenant" })
      .returning();
    const put = await authedFetch(`/v1/settings/tokens.prices?tenant=${otherTenant!.id}`, {
      method: "PUT",
      body: JSON.stringify({
        value: [{ model: "gpt-4.1-mini", input_per_mtok: 0.01, output_per_mtok: 0.02 }],
      }),
    });
    expect(put.status).toBe(200);

    const priceOf = async (res: Response) => {
      expect(res.status).toBe(200);
      const body = (await res.json()) as CatalogBody;
      return body.models.find((m) => m.model === "gpt-4.1-mini");
    };
    expect(
      await priceOf(await authedFetch(`/v1/settings/catalog/models?tenant=${otherTenant!.id}`)),
    ).toMatchObject({ price_source: "override", input_per_mtok: 0.01 });
    expect(
      await priceOf(await authedFetch(`/v1/settings/catalog/models?tenant=${server.tenantId}`)),
    ).toMatchObject({ price_source: "catalog", input_per_mtok: 0.4 });
    expect(await priceOf(await authedFetch("/v1/settings/catalog/models"))).toMatchObject({
      price_source: "catalog",
    });

    const otherMember = await memberKey(otherTenant!.id, ["*"]);
    const ownView = await fetch(`${server.baseUrl}/v1/settings/catalog/models`, {
      headers: { authorization: `Bearer ${otherMember}` },
    });
    expect(await priceOf(ownView)).toMatchObject({ price_source: "override" });
    const crossRead = await fetch(
      `${server.baseUrl}/v1/settings/catalog/models?tenant=${server.tenantId}`,
      { headers: { authorization: `Bearer ${otherMember}` } },
    );
    expect(crossRead.status).toBe(403);
  });

  test("the catalog carries no secret references or key material", async () => {
    await authedFetch(`/v1/settings/llm.api_key?tenant=${server.tenantId}`, {
      method: "PUT",
      body: JSON.stringify({ value: "catalog-leak-probe-key" }),
    });
    const res = await authedFetch(`/v1/settings/catalog/models?tenant=${server.tenantId}`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("secret://");
    expect(text).not.toContain("catalog-leak-probe-key");
    expect(text).not.toContain("api_key");
  });
});
