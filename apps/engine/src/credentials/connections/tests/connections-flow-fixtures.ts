import { afterAll, beforeAll, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../../config/loader.ts";
import { outboundConnections } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import type { getCredentialForConnector } from "../../service.ts";
import type { ConnectionView } from "../types.ts";
import { type FakeOAuthServer, startFakeOAuthServer } from "./fake-oauth-server.ts";

export let server: HttpTestServer;

export let fake: FakeOAuthServer;

export function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${server.apiKey}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

export async function approveInBrowser(authorizationUrl: string): Promise<Response> {
  const consent = await fetch(authorizationUrl, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const callback = consent.headers.get("location") ?? "";
  expect(callback.startsWith(`${server.baseUrl}/v1/connections/callback?`)).toBe(true);
  const landed = await fetch(callback, { redirect: "manual" });
  expect([200, 303]).toContain(landed.status);
  return landed;
}

export function accessTokenOf(
  resolved: Awaited<ReturnType<typeof getCredentialForConnector>>,
): string {
  const value = resolved?.value;
  return value && "access_token" in value ? value.access_token : "";
}

export async function listConnections(): Promise<ConnectionView[]> {
  const res = await api("/v1/connections");
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: ConnectionView[] }).items;
}

export async function authorityRevision(connectionId: string): Promise<number> {
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

export function useConnectionsServer(): void {
  beforeAll(async () => {
    server = await createHttpTestServer("connections");
    fake = await startFakeOAuthServer({ name: "Probe Service" });
    await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
  });
  afterAll(async () => {
    await fake.close();
    await server.cleanup();
  });
}
