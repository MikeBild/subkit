// The whole "Verbinden" flow against the in-repo OAuth 2.1 server — the
// isolation probe: nothing here knows any product but this one, and the
// server on the other side verifies what a real one verifies.
//
//   discover → start (registration + PKCE) → the other side approves →
//   callback → tokens are secret versions → a connector uses the connection →
//   the sweep refreshes before expiry → a refused refresh reads "expired" →
//   "Erneuern" repeats the flow → "Trennen" revokes and forgets.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { setConfigKey } from "../../../config/loader.ts";
import { loadConnectorSystem } from "../../../connectors/system.ts";
import {
  auditLog,
  connectors,
  credentials,
  outboundConnections,
  runtimeSecretVersions,
} from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { listSecretVersions } from "../../../runtime-config/service.ts";
import { getCredentialForConnector } from "../../service.ts";
import { readAccessToken, refreshDueConnections, secretNames } from "../service.ts";
import type { ConnectionView } from "../types.ts";
import { type FakeOAuthServer, startFakeOAuthServer } from "./fake-oauth-server.ts";

let server: HttpTestServer;
let fake: FakeOAuthServer;

beforeAll(async () => {
  server = await createHttpTestServer("connections");
  fake = await startFakeOAuthServer({ name: "Probe Service" });
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
});

afterAll(async () => {
  await fake.close();
  await server.cleanup();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${server.apiKey}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

/** Play the browser: visit the authorization URL, follow the one redirect back, return where the Cockpit lands. */
async function approveInBrowser(authorizationUrl: string): Promise<URL> {
  const consent = await fetch(authorizationUrl, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const callback = consent.headers.get("location") ?? "";
  expect(callback.startsWith(`${server.baseUrl}/v1/connections/callback?`)).toBe(true);
  const landed = await fetch(callback, { redirect: "manual" });
  expect(landed.status).toBe(302);
  return new URL(landed.headers.get("location") ?? "");
}

/** The token a connector would send, or "" when the credential resolves to nothing. */
function accessTokenOf(resolved: Awaited<ReturnType<typeof getCredentialForConnector>>): string {
  const value = resolved?.value;
  return value && "access_token" in value ? value.access_token : "";
}

async function listConnections(): Promise<ConnectionView[]> {
  const res = await api("/v1/connections");
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: ConnectionView[] }).items;
}

describe("Anbindungen → Verbinden against a foreign OAuth 2.1 server", () => {
  let connectionId = "";
  let connectorId = "";

  async function authorityRevision(): Promise<number> {
    const [row] = await server.db
      .select({ revision: outboundConnections.authority_revision })
      .from(outboundConnections)
      .where(
        and(
          eq(outboundConnections.tenant_id, server.tenantId),
          eq(outboundConnections.id, connectionId),
        ),
      );
    if (!row) throw new Error("missing connection fixture");
    return row.revision;
  }

  test("discover says what is there, in words the page can show", async () => {
    const res = await api("/v1/connections/discover", {
      method: "POST",
      body: JSON.stringify({ base_url: `${fake.baseUrl}/` }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      base_url: fake.baseUrl,
      connectable: true,
      reason: null,
      service_name: "Probe Service",
      service_version: "0.0.1",
      issuer: fake.baseUrl,
      scopes_supported: ["read", "write", "admin"],
    });
  });

  test("discover names a server without registration as not connectable, not as broken", async () => {
    fake.registration = false;
    try {
      const res = await api("/v1/connections/discover", {
        method: "POST",
        body: JSON.stringify({ base_url: fake.baseUrl }),
      });
      expect(await res.json()).toMatchObject({
        connectable: false,
        reason: "registration_missing",
      });
    } finally {
      fake.registration = true;
    }
  });

  test("start registers this engine as a public client and hands back the authorization URL", async () => {
    fake.requests.length = 0;
    const res = await api("/v1/connections/start", {
      method: "POST",
      body: JSON.stringify({ name: "Probe", base_url: fake.baseUrl, scopes: ["read", "write"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_url: string; name: string };
    expect(body.name).toBe("probe");
    const url = new URL(body.authorization_url);
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.baseUrl}/authorize`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("redirect_uri")).toBe(`${server.baseUrl}/v1/connections/callback`);

    // What the other side stored about us: a public client with our address.
    const registered = [...fake.clients.values()];
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      client_name: "SubKit",
      client_uri: server.baseUrl,
      redirect_uris: [`${server.baseUrl}/v1/connections/callback`],
    });
    expect(fake.requests).toEqual([
      "GET /.well-known/oauth-authorization-server",
      "GET /.well-known/service-descriptor.json",
      "POST /register",
    ]);

    const landed = await approveInBrowser(body.authorization_url);
    expect(landed.pathname).toBe("/cockpit/connections");
    expect(landed.searchParams.get("connected")).toBe("probe");
    expect(landed.searchParams.get("renewed")).toBeNull();
  });

  test("the connection is listed as valid, renewing itself, with what was granted", async () => {
    const [item] = await listConnections();
    expect(item).toMatchObject({
      name: "probe",
      base_url: fake.baseUrl,
      issuer: fake.baseUrl,
      service_name: "Probe Service",
      scopes: ["read", "write"],
      granted_scopes: ["read", "write"],
      state: "valid",
      auto_renew: true,
      used_by_connectors: 0,
      refresh_failed_at: null,
    });
    expect(item?.expires_at).not.toBeNull();
    connectionId = item?.id ?? "";

    // The tokens are runtime secret versions — nothing on the row.
    const names = secretNames(server.tenantId, "probe");
    const registry = await listSecretVersions(server.db);
    expect(registry.find((s) => s.name === names.access)?.versions).toHaveLength(1);
    expect(registry.find((s) => s.name === names.refresh)?.versions).toHaveLength(1);
    const [row] = await server.db
      .select()
      .from(outboundConnections)
      .where(eq(outboundConnections.id, connectionId));
    expect(JSON.stringify(row)).not.toContain(fake.accessTokens[0] ?? "never");

    const created = await server.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, server.tenantId), eq(auditLog.action, "connection.created")),
      );
    expect(created).toHaveLength(1);
    expect(JSON.stringify(created[0]?.metadata)).not.toContain(fake.accessTokens[0] ?? "never");
  });

  test("a connector can use the connection instead of a pasted key", async () => {
    const [connector] = await server.db
      .insert(connectors)
      .values({
        tenant_id: server.tenantId,
        slug: "probe-api",
        display_name: "Probe API",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: `${fake.baseUrl}/api`,
      })
      .returning({ id: connectors.id });
    connectorId = connector?.id ?? "";

    const attach = await api(`/v1/connectors/${connectorId}/credentials`, {
      method: "POST",
      body: JSON.stringify({ mode: "connection", connection_id: connectionId }),
    });
    expect(attach.status).toBe(201);

    const summary = await api(`/v1/connectors/${connectorId}/credential`);
    expect(await summary.json()).toMatchObject({
      mode: "connection",
      environment: "dev",
      connection: { id: connectionId, name: "probe" },
    });

    const resolved = await getCredentialForConnector(
      server.tenantId,
      connectorId,
      "dev",
      server.db,
    );
    expect(resolved?.value).toMatchObject({
      mode: "oauth2",
      token_type: "Bearer",
      access_token: fake.accessTokens.at(-1),
    });
    // The token the connector would send is one the other side accepts.
    const probe = await fetch(`${fake.baseUrl}/api/whoami`, {
      headers: { authorization: `Bearer ${accessTokenOf(resolved)}` },
    });
    expect(probe.status).toBe(200);

    const [item] = await listConnections();
    expect(item?.used_by_connectors).toBe(1);
    expect(item?.last_used_at).not.toBeNull();
  });

  test("the sweep refreshes a grant before it expires and retires the old version", async () => {
    const beforeAuthority = await authorityRevision();
    const before = fake.accessTokens.length;
    await server.db
      .update(outboundConnections)
      .set({ expires_at: new Date(Date.now() + 60_000) }) // allow-wall-clock: inside the refresh buffer
      .where(eq(outboundConnections.id, connectionId));
    const system = await loadConnectorSystem(server.tenantId, connectorId, "dev", server.db);
    if (!system) throw new Error("missing connector fixture");
    const beforeRequests = fake.requests.length;
    const metadata = await system.getAuthorityMetadata();
    expect(metadata.available).toBe(true);
    expect(fake.requests.length).toBe(beforeRequests);
    expect(fake.accessTokens.length).toBe(before);
    expect(JSON.stringify(metadata)).not.toContain(
      fake.accessTokens.at(-1) ?? "fixture-token-not-present",
    );
    expect(await refreshDueConnections(server.db)).toEqual({ refreshed: 1, failed: 0 });
    expect(fake.accessTokens.length).toBe(before + 1);
    expect(fake.requests.at(-1)).toBe("POST /token");

    const names = secretNames(server.tenantId, "probe");
    const versions = await server.db
      .select({
        version: runtimeSecretVersions.version,
        revoked_at: runtimeSecretVersions.revoked_at,
      })
      .from(runtimeSecretVersions)
      .where(eq(runtimeSecretVersions.name, names.access))
      .orderBy(runtimeSecretVersions.version);
    expect(versions.map((v) => [v.version, v.revoked_at !== null])).toEqual([
      [1, true],
      [2, false],
    ]);
    const resolved = await getCredentialForConnector(
      server.tenantId,
      connectorId,
      "dev",
      server.db,
    );
    expect(accessTokenOf(resolved)).toBe(fake.accessTokens.at(-1) ?? "");
    expect(resolved?.connection_authority).toEqual({ id: connectionId, revision: beforeAuthority });
    const [item] = await listConnections();
    expect(item?.state).toBe("valid");
    expect(item?.last_refreshed_at).not.toBeNull();
    expect(await authorityRevision()).toBe(beforeAuthority);
    expect((await system.getAuthorityMetadata()).binding).toEqual(metadata.binding);
  });

  test("a refused refresh turns the state to expired and the connector sends nothing", async () => {
    fake.refuseRefresh = true;
    try {
      await server.db
        .update(outboundConnections)
        .set({ expires_at: new Date(Date.now() + 60_000) }) // allow-wall-clock: inside the refresh buffer
        .where(eq(outboundConnections.id, connectionId));
      expect(await refreshDueConnections(server.db)).toEqual({ refreshed: 0, failed: 1 });
      const [item] = await listConnections();
      expect(item).toMatchObject({
        state: "expired",
        last_error: expect.stringContaining("invalid_grant"),
      });
      expect(item?.refresh_failed_at).not.toBeNull();
      // A failed grant is not retried on every request; it waits for "Erneuern".
      expect(await readAccessToken(server.db, server.tenantId, connectionId)).toMatchObject({
        access_token: fake.accessTokens.at(-1),
      });
      await server.db
        .update(outboundConnections)
        .set({ expires_at: new Date(Date.now() - 1_000) }) // allow-wall-clock: already past
        .where(eq(outboundConnections.id, connectionId));
      expect(await readAccessToken(server.db, server.tenantId, connectionId)).toBeNull();
      const resolved = await getCredentialForConnector(
        server.tenantId,
        connectorId,
        "dev",
        server.db,
      );
      expect(accessTokenOf(resolved)).toBe("");
    } finally {
      fake.refuseRefresh = false;
    }
  });

  test("Erneuern repeats the flow for the same row and clears the failure", async () => {
    const beforeAuthority = await authorityRevision();
    const res = await api(`/v1/connections/${connectionId}/renew`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_url: string; name: string };
    expect(body.name).toBe("probe");
    const landed = await approveInBrowser(body.authorization_url);
    expect(landed.searchParams.get("connected")).toBe("probe");
    expect(landed.searchParams.get("renewed")).toBe("1");
    const items = await listConnections();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: connectionId,
      state: "valid",
      refresh_failed_at: null,
      last_error: null,
      used_by_connectors: 1,
    });
    const resolved = await getCredentialForConnector(
      server.tenantId,
      connectorId,
      "dev",
      server.db,
    );
    expect(accessTokenOf(resolved)).toBe(fake.accessTokens.at(-1) ?? "");
    expect(await authorityRevision()).toBe(beforeAuthority + 1);
  });

  test("a refresh response with broader permissions changes the authority binding", async () => {
    // Model the stored prior grant as read-only; the IdP's next response
    // explicitly grants read + write. This is not an ordinary token renewal.
    const beforeAuthority = await authorityRevision();
    await server.db
      .update(outboundConnections)
      .set({
        granted_scopes: ["read"],
        expires_at: new Date(Date.now() + 60_000), // allow-wall-clock: inside the refresh buffer
      })
      .where(
        and(
          eq(outboundConnections.tenant_id, server.tenantId),
          eq(outboundConnections.id, connectionId),
        ),
      );
    expect(await refreshDueConnections(server.db)).toEqual({ refreshed: 1, failed: 0 });
    expect(await authorityRevision()).toBe(beforeAuthority + 1);
    const [item] = await listConnections();
    expect(item?.granted_scopes).toEqual(["read", "write"]);
  });

  test("a late refresh cannot replace a newer human grant or change its secrets", async () => {
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.beforeRefreshResponse = async () => {
      reached();
      await held;
    };
    await server.db
      .update(outboundConnections)
      .set({ expires_at: new Date(Date.now() + 60_000) }) // allow-wall-clock: inside refresh buffer
      .where(eq(outboundConnections.id, connectionId));
    const refreshing = refreshDueConnections(server.db);
    try {
      await waiting;
      const beforeAuthority = await authorityRevision();
      const res = await api(`/v1/connections/${connectionId}/renew`, { method: "POST" });
      expect(res.status).toBe(200);
      await approveInBrowser(
        ((await res.json()) as { authorization_url: string }).authorization_url,
      );
      const renewedToken = fake.accessTokens.at(-1);
      const secretSnapshot = await listSecretVersions(server.db);
      release();
      expect(await refreshing).toEqual({ refreshed: 0, failed: 1 });
      expect(await authorityRevision()).toBe(beforeAuthority + 1);
      expect(await listSecretVersions(server.db)).toEqual(secretSnapshot);
      expect(await readAccessToken(server.db, server.tenantId, connectionId)).toMatchObject({
        access_token: renewedToken,
      });
      expect((await listConnections())[0]).toMatchObject({
        state: "valid",
        refresh_failed_at: null,
        last_error: null,
      });
    } finally {
      release();
      await refreshing;
      delete fake.beforeRefreshResponse;
    }
  });

  test("an unavailable audit rolls back refresh secrets, scopes, and authority together", async () => {
    await server.db
      .update(outboundConnections)
      .set({ granted_scopes: ["read"], expires_at: new Date(Date.now() + 60_000) }) // allow-wall-clock: inside refresh buffer
      .where(eq(outboundConnections.id, connectionId));
    const beforeAuthority = await authorityRevision();
    const secretSnapshot = await listSecretVersions(server.db);
    await server.db.execute(
      sql.raw(`CREATE FUNCTION subkit.reject_connection_refresh_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'connection.refreshed' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_connection_refresh_audit BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.reject_connection_refresh_audit()`),
    );
    try {
      expect(await refreshDueConnections(server.db)).toEqual({ refreshed: 0, failed: 1 });
      expect(await authorityRevision()).toBe(beforeAuthority);
      expect(await listSecretVersions(server.db)).toEqual(secretSnapshot);
      expect((await listConnections())[0]?.granted_scopes).toEqual(["read"]);
    } finally {
      await server.db.execute(
        sql.raw(
          "DROP TRIGGER reject_connection_refresh_audit ON subkit.audit_log; DROP FUNCTION subkit.reject_connection_refresh_audit()",
        ),
      );
    }
    // The foreign provider already consumed its refresh token; local rollback
    // cannot undo that external action. A fresh human login repairs the grant.
    const res = await api(`/v1/connections/${connectionId}/renew`, { method: "POST" });
    expect(res.status).toBe(200);
    await approveInBrowser(((await res.json()) as { authorization_url: string }).authorization_url);
  });

  test("a denial on the other side lands in the Cockpit as failed=denied, and a state is spent once", async () => {
    fake.decision = "deny";
    try {
      const res = await api("/v1/connections/start", {
        method: "POST",
        body: JSON.stringify({ name: "refused", base_url: fake.baseUrl, scopes: ["read"] }),
      });
      const body = (await res.json()) as { authorization_url: string };
      const consent = await fetch(body.authorization_url, { redirect: "manual" });
      const callback = consent.headers.get("location") ?? "";
      expect(new URL(callback).searchParams.get("error")).toBe("access_denied");
      const landed = await fetch(callback, { redirect: "manual" });
      const where = new URL(landed.headers.get("location") ?? "");
      expect(where.searchParams.get("failed")).toBe("denied");
      expect(where.searchParams.get("name")).toBe("refused");
      // Replaying the same callback cannot do anything: the state is gone.
      const replay = await fetch(callback, { redirect: "manual" });
      expect(new URL(replay.headers.get("location") ?? "").searchParams.get("failed")).toBe(
        "state_invalid",
      );
      expect((await listConnections()).map((c) => c.name)).toEqual(["probe"]);
    } finally {
      fake.decision = "approve";
    }
  });

  test("a second connection may not take a taken name", async () => {
    const res = await api("/v1/connections/start", {
      method: "POST",
      body: JSON.stringify({ name: "probe", base_url: fake.baseUrl, scopes: ["read"] }),
    });
    expect(res.status).toBe(409);
  });

  test("Trennen revokes the versions, forgets the row, and leaves the connector without material", async () => {
    const res = await api(`/v1/connections/${connectionId}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await listConnections()).toEqual([]);
    const names = secretNames(server.tenantId, "probe");
    const live = await server.db
      .select({ name: runtimeSecretVersions.name })
      .from(runtimeSecretVersions)
      .where(
        and(eq(runtimeSecretVersions.name, names.access), eq(runtimeSecretVersions.version, 3)),
      );
    expect(live).toHaveLength(1);
    const registry = await listSecretVersions(server.db);
    expect(
      registry.find((s) => s.name === names.access)?.versions.every((v) => v.revoked_at !== null),
    ).toBe(true);
    const [cred] = await server.db
      .select({ connection_id: credentials.connection_id })
      .from(credentials)
      .where(eq(credentials.connector_id, connectorId));
    expect(cred?.connection_id).toBeNull();
    const summary = await api(`/v1/connectors/${connectorId}/credential`);
    expect(await summary.json()).toMatchObject({ mode: "oauth2", connection: null });
    expect(await api(`/v1/connections/${connectionId}`).then((r) => r.status)).toBe(404);
  });
});
