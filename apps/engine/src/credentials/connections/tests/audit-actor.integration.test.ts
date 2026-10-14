import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../../config/loader.ts";
import {
  apiKeys,
  auditLog,
  outboundConnectionStarts,
  outboundConnections,
  systemAccounts,
} from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { refreshDueConnections } from "../service.ts";
import { type FakeOAuthServer, startFakeOAuthServer } from "./fake-oauth-server.ts";

let server: HttpTestServer;
let fake: FakeOAuthServer;
let systemAccountApiKey: string;

beforeAll(async () => {
  server = await createHttpTestServer("connection-audit-actor");
  fake = await startFakeOAuthServer({ name: "Audit Actor Provider" });
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
  const [account] = await server.db
    .update(systemAccounts)
    .set({ role_id: await builtinRoleId(server.db, "admin") })
    .where(eq(systemAccounts.id, server.systemAccountId))
    .returning({ id: systemAccounts.id });
  if (!account) throw new Error("system account missing");
  systemAccountApiKey = "wf_live_SYS_connection_audit_actor_test_key_000";
  await server.db.insert(apiKeys).values({
    tenant_id: server.tenantId,
    system_account_id: account.id,
    prefix: systemAccountApiKey.slice(0, 12),
    token_sha256: createHash("sha256").update(systemAccountApiKey).digest("hex"),
    scopes: ["*"],
  });
});

afterAll(async () => {
  await fake.close();
  await server.cleanup();
});

function api(path: string, init: RequestInit = {}, key = server.apiKey): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

test("connection callbacks preserve actors, ownership, and system refresh provenance", async () => {
  const start = await api("/v1/connections/start", {
    method: "POST",
    body: JSON.stringify({
      name: "audit-actor-provider",
      base_url: fake.baseUrl,
      scopes: ["read"],
    }),
  });
  expect(start.status).toBe(200);
  const { authorization_url } = (await start.json()) as { authorization_url: string };
  const consent = await fetch(authorization_url, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const callback = await fetch(consent.headers.get("location") ?? "", { redirect: "manual" });
  expect([200, 303]).toContain(callback.status);

  const listing = await api("/v1/connections");
  expect(listing.status).toBe(200);
  const items = (await listing.json()) as { items: Array<{ id: string; name: string }> };
  const connection = items.items.find((item) => item.name === "audit-actor-provider");
  if (!connection) throw new Error("connection missing after OAuth callback");

  const [created] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, "connection.created"),
        eq(auditLog.resource_id, connection.id),
      ),
    );
  expect(created).toEqual({ actor_type: "user", actor_id: server.userId });

  const legacyUserStart = await api("/v1/connections/start", {
    method: "POST",
    body: JSON.stringify({
      name: "audit-actor-legacy-user",
      base_url: fake.baseUrl,
      scopes: ["read"],
    }),
  });
  expect(legacyUserStart.status).toBe(200);
  const legacyUserUrl = ((await legacyUserStart.json()) as { authorization_url: string })
    .authorization_url;
  const legacyUserState = new URL(legacyUserUrl).searchParams.get("state");
  if (!legacyUserState) throw new Error("legacy user OAuth state missing");
  await server.db
    .update(outboundConnectionStarts)
    .set({ actor_type: "unknown", actor_id: null, owner_user_id: null })
    .where(
      eq(
        outboundConnectionStarts.state_sha256,
        createHash("sha256").update(legacyUserState).digest("hex"),
      ),
    );
  const legacyUserConsent = await fetch(legacyUserUrl, { redirect: "manual" });
  const legacyUserCallback = await fetch(legacyUserConsent.headers.get("location") ?? "", {
    redirect: "manual",
  });
  expect([200, 303]).toContain(legacyUserCallback.status);
  const [legacyUserConnection] = await server.db
    .select({ id: outboundConnections.id, created_by: outboundConnections.created_by })
    .from(outboundConnections)
    .where(
      and(
        eq(outboundConnections.tenant_id, server.tenantId),
        eq(outboundConnections.name, "audit-actor-legacy-user"),
      ),
    );
  if (!legacyUserConnection) throw new Error("legacy user connection missing after callback");
  expect(legacyUserConnection.created_by).toBe(server.userId);
  const [legacyUserAudit] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, "connection.created"),
        eq(auditLog.resource_id, legacyUserConnection.id),
      ),
    );
  expect(legacyUserAudit).toEqual({ actor_type: "unknown", actor_id: null });

  const machineStart = await api(
    "/v1/connections/start",
    {
      method: "POST",
      body: JSON.stringify({
        name: "audit-actor-machine",
        base_url: fake.baseUrl,
        scopes: ["read"],
      }),
    },
    systemAccountApiKey,
  );
  expect(machineStart.status).toBe(200);
  const machineUrl = ((await machineStart.json()) as { authorization_url: string })
    .authorization_url;
  const machineState = new URL(machineUrl).searchParams.get("state");
  if (!machineState) throw new Error("system-account OAuth state missing");
  const [machinePending] = await server.db
    .select({
      actor_type: outboundConnectionStarts.actor_type,
      actor_id: outboundConnectionStarts.actor_id,
      owner_user_id: outboundConnectionStarts.owner_user_id,
      user_id: outboundConnectionStarts.user_id,
    })
    .from(outboundConnectionStarts)
    .where(
      eq(
        outboundConnectionStarts.state_sha256,
        createHash("sha256").update(machineState).digest("hex"),
      ),
    );
  expect(machinePending).toEqual({
    actor_type: "system_account",
    actor_id: server.systemAccountId,
    owner_user_id: null,
    user_id: null,
  });
  const machineConsent = await fetch(machineUrl, { redirect: "manual" });
  const machineCallback = await fetch(machineConsent.headers.get("location") ?? "", {
    redirect: "manual",
  });
  expect([200, 303]).toContain(machineCallback.status);
  const machineConnections = await api("/v1/connections", {}, systemAccountApiKey);
  expect(machineConnections.status).toBe(200);
  const machineItems = (await machineConnections.json()) as {
    items: Array<{ id: string; name: string }>;
  };
  const machineConnection = machineItems.items.find((item) => item.name === "audit-actor-machine");
  if (!machineConnection) throw new Error("system-account connection missing after OAuth callback");
  const [machineCreated] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, "connection.created"),
        eq(auditLog.resource_id, machineConnection.id),
      ),
    );
  expect(machineCreated).toEqual({
    actor_type: "system_account",
    actor_id: server.systemAccountId,
  });
  const [machineOwner] = await server.db
    .select({ created_by: outboundConnections.created_by })
    .from(outboundConnections)
    .where(eq(outboundConnections.id, machineConnection.id));
  expect(machineOwner?.created_by).toBeNull();

  const legacyMachineStart = await api(
    "/v1/connections/start",
    {
      method: "POST",
      body: JSON.stringify({
        name: "audit-actor-legacy-machine",
        base_url: fake.baseUrl,
        scopes: ["read"],
      }),
    },
    systemAccountApiKey,
  );
  expect(legacyMachineStart.status).toBe(200);
  const legacyMachineUrl = ((await legacyMachineStart.json()) as { authorization_url: string })
    .authorization_url;
  const legacyMachineState = new URL(legacyMachineUrl).searchParams.get("state");
  if (!legacyMachineState) throw new Error("legacy system-account OAuth state missing");
  await server.db
    .update(outboundConnectionStarts)
    .set({
      user_id: server.systemAccountId,
      actor_type: "unknown",
      actor_id: null,
      owner_user_id: null,
    })
    .where(
      eq(
        outboundConnectionStarts.state_sha256,
        createHash("sha256").update(legacyMachineState).digest("hex"),
      ),
    );
  const legacyMachineConsent = await fetch(legacyMachineUrl, { redirect: "manual" });
  const legacyMachineCallback = await fetch(legacyMachineConsent.headers.get("location") ?? "", {
    redirect: "manual",
  });
  expect([200, 303]).toContain(legacyMachineCallback.status);
  const [legacyMachineConnection] = await server.db
    .select({ id: outboundConnections.id, created_by: outboundConnections.created_by })
    .from(outboundConnections)
    .where(
      and(
        eq(outboundConnections.tenant_id, server.tenantId),
        eq(outboundConnections.name, "audit-actor-legacy-machine"),
      ),
    );
  if (!legacyMachineConnection) throw new Error("legacy machine connection missing after callback");
  expect(legacyMachineConnection.created_by).toBeNull();
  const [legacyMachineAudit] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, "connection.created"),
        eq(auditLog.resource_id, legacyMachineConnection.id),
      ),
    );
  expect(legacyMachineAudit).toEqual({ actor_type: "unknown", actor_id: null });

  const renewal = await api(
    `/v1/connections/${connection.id}/renew`,
    { method: "POST" },
    systemAccountApiKey,
  );
  expect(renewal.status).toBe(200);
  const renewalUrl = ((await renewal.json()) as { authorization_url: string }).authorization_url;
  const renewalConsent = await fetch(renewalUrl, { redirect: "manual" });
  const renewalCallback = await fetch(renewalConsent.headers.get("location") ?? "", {
    redirect: "manual",
  });
  expect([200, 303]).toContain(renewalCallback.status);

  const [renewed] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, "connection.renewed"),
        eq(auditLog.resource_id, connection.id),
      ),
    );
  expect(renewed).toEqual({ actor_type: "system_account", actor_id: server.systemAccountId });
  const [owner] = await server.db
    .select({ created_by: outboundConnections.created_by })
    .from(outboundConnections)
    .where(eq(outboundConnections.id, connection.id));
  expect(owner?.created_by).toBe(server.userId);

  await server.db
    .update(outboundConnections)
    .set({ expires_at: new Date(getTestNow() + 60_000) })
    .where(eq(outboundConnections.id, connection.id));
  expect(await refreshDueConnections(server.db)).toEqual({ refreshed: 1, failed: 0 });
  const [refresh] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, "connection.refreshed"),
        eq(auditLog.resource_id, connection.id),
      ),
    );
  expect(refresh).toEqual({ actor_type: "system", actor_id: null });

  const disconnected = await api(`/v1/connections/${connection.id}`, { method: "DELETE" });
  expect(disconnected.status).toBe(204);
  const [disconnect] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, "connection.disconnected"),
        eq(auditLog.resource_id, connection.id),
      ),
    );
  expect(disconnect).toEqual({ actor_type: "user", actor_id: server.userId });
});
