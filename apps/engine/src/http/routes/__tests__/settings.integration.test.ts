import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { apiKeys, tenants, users } from "../../../db/schema/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { authedFetch, det, nextSeq, server, setupSettingsRoutes } from "./settings-fixtures.ts";

setupSettingsRoutes();

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
