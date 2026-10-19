import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../../config/loader.ts";
import { auditLog, outboundConnections } from "../../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../../db/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { logger } from "../../../logging/logger.ts";
import { now } from "../../../utils/clock.ts";
import { refreshDueConnections } from "../service.ts";
import { type FakeOAuthServer, startFakeOAuthServer } from "./fake-oauth-server.ts";

let server: HttpTestServer;
let fake: FakeOAuthServer;
const canary =
  "https://issuer.example.test/token?secret=url-canary body-canary token-canary callback-query-canary";

beforeAll(async () => {
  server = await createHttpTestServer("connection-error-privacy");
  fake = await startFakeOAuthServer();
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
}, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  if (fake) await fake.close();
  if (server) await server.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function begin(name: string) {
  const start = await fetch(`${server.baseUrl}/v1/connections/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ name, base_url: fake.baseUrl, scopes: ["read"] }),
  });
  expect(start.status).toBe(200);
  return ((await start.json()) as { authorization_url: string }).authorization_url;
}

test("refresh failure stores and audits a fixed status without malicious provider content", async () => {
  const authorize = await begin("privacy-refresh");
  const consent = await fetch(authorize, { redirect: "manual" });
  const callback = await fetch(consent.headers.get("location") ?? "", { redirect: "manual" });
  expect([200, 303]).toContain(callback.status);
  const [connection] = await server.db
    .select()
    .from(outboundConnections)
    .where(
      and(
        eq(outboundConnections.tenant_id, server.tenantId),
        eq(outboundConnections.name, "privacy-refresh"),
      ),
    );
  if (!connection) throw new Error("connection fixture missing");
  await server.db
    .update(outboundConnections)
    .set({ expires_at: new Date(now() + 1000) })
    .where(
      and(
        eq(outboundConnections.tenant_id, server.tenantId),
        eq(outboundConnections.id, connection.id),
      ),
    );
  fake.refuseRefresh = true;
  fake.refreshError = canary;
  const logs: unknown[] = [];
  const spies = [spyOn(logger, "warn"), spyOn(logger, "info")];
  for (const spy of spies)
    spy.mockImplementation((...args) => {
      logs.push(args);
    });
  try {
    expect(await refreshDueConnections(server.db)).toEqual({ refreshed: 0, failed: 1 });
    const [failed] = await server.db
      .select({ last_error: outboundConnections.last_error })
      .from(outboundConnections)
      .where(
        and(
          eq(outboundConnections.tenant_id, server.tenantId),
          eq(outboundConnections.id, connection.id),
        ),
      );
    expect(failed?.last_error).toBe("token endpoint refused: http_400");
    const audits = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.resource_id, connection.id),
          eq(auditLog.action, "connection.refresh_failed"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify({ audits, logs, failed })).not.toContain("canary");
  } finally {
    for (const spy of spies) spy.mockRestore();
    fake.refuseRefresh = false;
  }
});

test("authorization callback error queries are never echoed in failure audit or returned page", async () => {
  const authorize = new URL(await begin("privacy-callback"));
  const callback = new URL(`${server.baseUrl}/v1/connections/callback`);
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  callback.searchParams.set("error", canary);
  const logs: unknown[] = [];
  const spies = [spyOn(logger, "warn"), spyOn(logger, "info"), spyOn(logger, "error")];
  for (const spy of spies)
    spy.mockImplementation((...args) => {
      logs.push(args);
    });
  try {
    const response = await fetch(callback, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("canary");
    const audits = await server.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, server.tenantId), eq(auditLog.action, "connection.failed")),
      );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify({ audits, logs })).not.toContain("canary");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
