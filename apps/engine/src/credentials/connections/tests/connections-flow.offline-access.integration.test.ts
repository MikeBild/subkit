import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, outboundConnections } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/index.ts";
import { listSecretVersions } from "../../../runtime-config/service.ts";
import { secretNames } from "../service.ts";
import type { ConnectionView } from "../types.ts";
import {
  api,
  approveInBrowser,
  fake,
  listConnections,
  server,
  useConnectionsServer,
} from "./connections-flow-fixtures.ts";
import { type FakeOAuthServer, startFakeOAuthServer } from "./fake-oauth-server.ts";

useConnectionsServer();

describe("a server that issues refresh tokens only for offline_access", () => {
  let oidc: FakeOAuthServer;

  beforeAll(async () => {
    oidc = await startFakeOAuthServer({
      name: "OIDC Probe",
      scopes: ["openid", "read", "offline_access"],
      refreshRequiresOfflineAccess: true,
    });
  });

  afterAll(async () => {
    await oidc.close();
  });

  async function view(name: string): Promise<ConnectionView> {
    const item = (await listConnections()).find((c) => c.name === name);
    if (!item) throw new Error(`connection ${name} not listed`);
    return item;
  }

  test("discover offers the permissions, not the protocol scope", async () => {
    const res = await api("/v1/connections/discover", {
      method: "POST",
      body: JSON.stringify({ base_url: oidc.baseUrl }),
    });
    expect(((await res.json()) as { scopes_supported: string[] }).scopes_supported).toEqual([
      "openid",
      "read",
    ]);
  });

  test("start asks for offline_access itself, and the grant renews itself", async () => {
    oidc.clients.clear();
    const res = await api("/v1/connections/start", {
      method: "POST",
      body: JSON.stringify({ name: "oidc", base_url: oidc.baseUrl, scopes: ["read"] }),
    });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { authorization_url: string }).authorization_url);
    expect(url.searchParams.get("scope")).toBe("read offline_access");
    expect([...oidc.clients.values()].map((c) => c.scope)).toEqual(["read offline_access"]);
    await approveInBrowser(url.toString());

    const item = await view("oidc");
    expect(item).toMatchObject({
      state: "valid",
      auto_renew: true,
      scopes: ["read"],
      granted_scopes: ["read"],
    });
  });

  test("Erneuern asks for offline_access again, even for a row that never had it", async () => {
    const item = await view("oidc");
    await server.db
      .update(outboundConnections)
      .set({ refresh_token_version: null })
      .where(eq(outboundConnections.id, item.id));
    expect((await view("oidc")).auto_renew).toBe(false);

    oidc.clients.clear();
    const res = await api(`/v1/connections/${item.id}/renew`, { method: "POST" });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { authorization_url: string }).authorization_url);
    expect(url.searchParams.get("scope")).toBe("read offline_access");
    expect([...oidc.clients.values()].map((c) => c.scope)).toEqual(["read offline_access"]);
    await approveInBrowser(url.toString());
    expect(await view("oidc")).toMatchObject({ state: "valid", auto_renew: true });
  });

  test("a server that does not advertise offline_access is not asked for it", async () => {
    fake.clients.clear();
    const res = await api("/v1/connections/start", {
      method: "POST",
      body: JSON.stringify({
        name: "plain",
        base_url: fake.baseUrl,
        scopes: ["read", "offline_access"],
      }),
    });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { authorization_url: string }).authorization_url);
    expect(url.searchParams.get("scope")).toBe("read");
    expect([...fake.clients.values()].map((c) => c.scope)).toEqual(["read"]);
    await approveInBrowser(url.toString());
    expect(await view("plain")).toMatchObject({ scopes: ["read"], auto_renew: true });
  });

  test("a grant without a refresh token says so: a warning, auto_renew false, the old one retired", async () => {
    const before = await view("oidc");
    const [row] = await server.db
      .select({ refresh: outboundConnections.refresh_token_version })
      .from(outboundConnections)
      .where(eq(outboundConnections.id, before.id));
    expect(row?.refresh).not.toBeNull();

    const warnings: Record<string, unknown>[] = [];
    const spy = spyOn(logger, "warn").mockImplementation(((entry: unknown) => {
      if (entry && typeof entry === "object") warnings.push(entry as Record<string, unknown>);
    }) as typeof logger.warn);
    oidc.issueRefreshToken = false;
    try {
      const res = await api(`/v1/connections/${before.id}/renew`, { method: "POST" });
      const url = ((await res.json()) as { authorization_url: string }).authorization_url;
      await approveInBrowser(url);
    } finally {
      oidc.issueRefreshToken = true;
      spy.mockRestore();
    }

    const warning = warnings.find((w) => w.action === "connection.no_refresh_token");
    expect(warning).toMatchObject({ module: "connections", name: "oidc" });
    expect(warning?.expires_at).toEqual(expect.any(String));
    expect(JSON.stringify(warning)).not.toContain(oidc.accessTokens.at(-1) ?? "never");

    const after = await view("oidc");
    expect(after).toMatchObject({ state: "expiring", auto_renew: false, state_reason: null });
    const names = secretNames(server.tenantId, "oidc");
    const registry = await listSecretVersions(server.db);
    const previous = registry
      .find((s) => s.name === names.refresh)
      ?.versions.find((v) => v.version === row?.refresh);
    expect(previous?.revoked_at ?? null).not.toBeNull();
  });

  test("disconnect attributes the authenticated HTTP principal", async () => {
    const item = await view("plain");
    const response = await api(`/v1/connections/${item.id}`, { method: "DELETE" });
    expect(response.status).toBe(204);
    const [audit] = await server.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, "connection.disconnected"),
          eq(auditLog.resource_id, item.id),
        ),
      );
    expect(audit).toEqual({ actor_type: "user", actor_id: server.userId });
  });
});
