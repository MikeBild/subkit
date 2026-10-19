import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { McpClientAdmissionError } from "../auth/oauth/client-registration.ts";
import { createMcpOAuthProvider } from "../auth/oauth/server-provider.ts";
import { getConfig, setConfigKey } from "../config/loader.ts";
import {
  authIdentities,
  httpRateLimitBuckets,
  mcpOauthClients,
  tenants,
} from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { provisionSelfServiceTenant } from "./self-service.ts";

let ctx: HttpTestServer;
let sequence = 0;
const redirect = "https://client.example.test/callback";
beforeAll(async () => {
  ctx = await createHttpTestServer("hosted-registration-admission", { operator: false });
});
afterAll(async () => {
  await ctx?.cleanup();
});
beforeEach(async () => {
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
  await setConfigKey("auth.hosted.enabled", false);
  await ctx.db.delete(httpRateLimitBuckets);
  await ctx.db.delete(mcpOauthClients);
});
function claims() {
  sequence++;
  return {
    issuer_url: "https://identity.example.test",
    subject: `admission-${sequence}`,
    email: `admission-${sequence}@example.test`,
    email_verified: true as const,
  };
}
function client(peer = "peer-a") {
  return createMcpOAuthProvider({ db: ctx.db, config: getConfig() }).registerClient({
    redirect_uris: [redirect],
    registration_peer: peer,
  });
}
test("selfhost client registration retains existing behavior without hosted policy", async () => {
  await setConfigKey("auth.hosted.admission.retained_mcp_clients", 0);
  expect((await client()).client_id).toBeString();
});
test("parallel verified identities admit exactly the configured tenant creation rate and roll back rejected identities", async () => {
  await setConfigKey("auth.hosted.admission.tenant_creations_per_minute", 1);
  const identities = [claims(), claims()];
  const results = await Promise.allSettled(
    identities.map((identity) => provisionSelfServiceTenant(identity, ctx.db)),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const rejected = results.findIndex((result) => result.status === "rejected");
  expect(
    await ctx.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.subject, identities[rejected]?.subject ?? "")),
  ).toHaveLength(0);
  const buckets = await ctx.db.select().from(httpRateLimitBuckets);
  expect(buckets).toHaveLength(1);
  expect(buckets[0]?.hits).toBe(1);
});
test("idempotent callbacks consume one creation admission and still replay with new registration blocked", async () => {
  const identity = claims();
  await setConfigKey("auth.hosted.admission.tenant_creations_per_minute", 1);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => provisionSelfServiceTenant(identity, ctx.db)),
  );
  expect(results.filter((result) => result.created)).toHaveLength(1);
  expect(new Set(results.map((result) => result.tenant.id)).size).toBe(1);
  await setConfigKey("auth.hosted.admission.tenant_creations_per_minute", 0);
  expect((await provisionSelfServiceTenant(identity, ctx.db)).created).toBe(false);
  await expect(provisionSelfServiceTenant(claims(), ctx.db)).rejects.toThrow(
    "registration_policy_unavailable",
  );
  expect((await ctx.db.select().from(httpRateLimitBuckets))[0]?.hits).toBe(1);
});
test("operator tenant stock includes deleted ownership tombstones and serializes competing creates", async () => {
  const [stock] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(tenants)
    .where(eq(tenants.origin, "self_service"));
  await setConfigKey("auth.hosted.admission.retained_tenants", (stock?.count ?? 0) + 1);
  const outcomes = await Promise.allSettled(
    [claims(), claims()].map((identity) => provisionSelfServiceTenant(identity, ctx.db)),
  );
  const accepted = outcomes.find((result) => result.status === "fulfilled");
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  if (accepted?.status !== "fulfilled") throw new Error("missing tenant");
  await ctx.db
    .update(tenants)
    .set({ deleted_at: new Date(FROZEN_NOW) })
    .where(eq(tenants.id, accepted.value.tenant.id));
  await expect(provisionSelfServiceTenant(claims(), ctx.db)).rejects.toThrow(
    "registration_policy_unavailable",
  );
});
test("MCP rate admission survives factory recreation and per-peer denial does not burn the global allowance", async () => {
  await setConfigKey("auth.hosted.admission.mcp_clients_per_peer_per_minute", 1);
  await setConfigKey("auth.hosted.admission.mcp_clients_per_minute", 2);
  await client("peer-a");
  await expect(client("peer-a")).rejects.toBeInstanceOf(McpClientAdmissionError);
  expect((await client("peer-b")).client_id).toBeString();
  await expect(client("peer-c")).rejects.toBeInstanceOf(McpClientAdmissionError);
  expect(await ctx.db.select().from(mcpOauthClients)).toHaveLength(2);
});
test("parallel direct MCP registration enforces retained stock, including disabled and retired clients", async () => {
  await setConfigKey("auth.hosted.admission.retained_mcp_clients", 1);
  const results = await Promise.allSettled([client("a"), client("b")]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const [registered] = await ctx.db.select().from(mcpOauthClients);
  if (!registered) throw new Error("missing client");
  await ctx.db
    .update(mcpOauthClients)
    .set({ disabled_at: new Date(FROZEN_NOW), retired_at: new Date(FROZEN_NOW) })
    .where(eq(mcpOauthClients.id, registered.id));
  await expect(client("c")).rejects.toBeInstanceOf(McpClientAdmissionError);
  expect(await ctx.db.select().from(mcpOauthClients)).toHaveLength(1);
});
test("retained hosted tenancy requires MCP policy even when hosted service and signup flags are off", async () => {
  expect(getConfig().auth.hosted.enabled).toBe(false);
  await setConfigKey("auth.hosted.admission.mcp_clients_per_minute", 0);
  await expect(client()).rejects.toBeInstanceOf(McpClientAdmissionError);
  expect(await ctx.db.select().from(mcpOauthClients)).toHaveLength(0);
});
test("actual MCP DCR route passes the verified peer to durable admission and returns readable denial", async () => {
  await setConfigKey("auth.hosted.admission.mcp_clients_per_peer_per_minute", 1);
  const request = () =>
    fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.21" },
      body: JSON.stringify({ redirect_uris: [redirect] }),
    });
  expect((await request()).status).toBe(201);
  const rejected = await request();
  expect(rejected.status).toBe(429);
  expect(await rejected.json()).toMatchObject({ error: "too_many_requests" });
  expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
});
