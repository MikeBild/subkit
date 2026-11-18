import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { apiKeys, auditLog, deliveries, systemAccounts, workflows } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let server: HttpTestServer;
let systemAccountApiKey: string;

beforeAll(async () => {
  server = await createHttpTestServer("audit-attribution", {
    appOptions: { boss: { send: async () => "fixture-job" } as unknown as PgBoss },
  });
  await server.db
    .update(systemAccounts)
    .set({ role_id: await builtinRoleId(server.db, "admin") })
    .where(eq(systemAccounts.id, server.systemAccountId));
  systemAccountApiKey = "wf_live_SYS_route_audit_attribution_key_000";
  await server.db.insert(apiKeys).values({
    tenant_id: server.tenantId,
    system_account_id: server.systemAccountId,
    prefix: systemAccountApiKey.slice(0, 12),
    token_sha256: createHash("sha256").update(systemAccountApiKey).digest("hex"),
    scopes: ["*"],
  });
});

afterAll(async () => {
  await server.cleanup();
});

function api(path: string, init: RequestInit = {}, key = server.apiKey): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

test("authenticated webhook and subscription routes persist typed actor pairs", async () => {
  const [workflow] = await server.db
    .insert(workflows)
    .values({
      tenant_id: server.tenantId,
      slug: "audit-attribution-workflow",
      name: "Audit attribution workflow",
      lifecycle: "draft",
      is_tool: false,
    })
    .returning({ id: workflows.id });
  if (!workflow) throw new Error("workflow insert returned no row");

  const emitEvent = async (key: string) => {
    const response = await api(
      "/v1/events",
      {
        method: "POST",
        body: JSON.stringify({
          type: "workflow.updated",
          payload: { workflow_id: workflow.id, version: 1 },
        }),
      },
      key,
    );
    expect(response.status).toBe(202);
    return (await response.json()) as { event_id: number };
  };
  const userEvent = await emitEvent(server.apiKey);
  const systemEvent = await emitEvent(systemAccountApiKey);

  const createInbound = async (slug: string, key: string) => {
    const response = await api(
      "/v1/webhooks/inbound",
      {
        method: "POST",
        body: JSON.stringify({
          slug,
          workflow_id: workflow.id,
          verifier: "hmac",
          secret: `fixture-${slug}-secret`,
          native_verifier_config: {
            hmac: { signature_header: "x-signature", id_header: "x-event-id" },
          },
        }),
      },
      key,
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  };
  const inbound = await createInbound("audit-attribution-inbound", server.apiKey);
  const systemInbound = await createInbound(
    "audit-attribution-system-inbound",
    systemAccountApiKey,
  );

  const createSubscription = async (name: string, key: string) => {
    const response = await api(
      "/v1/subscriptions",
      {
        method: "POST",
        body: JSON.stringify({
          event_pattern: name,
          target_url: `https://example.test/${name}`,
          secret: `fixture-${name}-secret`,
        }),
      },
      key,
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  };
  const subscription = await createSubscription("audit.attribution", server.apiKey);
  const systemSubscription = await createSubscription(
    "audit.attribution.system",
    systemAccountApiKey,
  );

  const addReplayFixture = async (subscriptionId: string) => {
    const [delivery] = await server.db
      .insert(deliveries)
      .values({
        tenant_id: server.tenantId,
        subscription_id: subscriptionId,
        event_id: workflow.id,
        attempt: 1,
        attempt_number: 1,
        status: "dead_letter",
        event_type: "workflow.updated",
      })
      .returning({ id: deliveries.id });
    if (!delivery) throw new Error("delivery insert returned no row");
    return delivery.id;
  };
  const replayUserDelivery = await addReplayFixture(subscription.id);
  const replaySystemDelivery = await addReplayFixture(systemSubscription.id);
  expect(
    (
      await api(`/v1/subscriptions/${subscription.id}/deliveries/${replayUserDelivery}/replay`, {
        method: "POST",
      })
    ).status,
  ).toBe(202);
  expect(
    (
      await api(
        `/v1/subscriptions/${systemSubscription.id}/deliveries/${replaySystemDelivery}/replay`,
        { method: "POST" },
        systemAccountApiKey,
      )
    ).status,
  ).toBe(202);

  const updateSubscription = async (id: string, key: string) =>
    api(
      `/v1/subscriptions/${id}`,
      { method: "PATCH", body: JSON.stringify({ active: false }) },
      key,
    );
  expect((await updateSubscription(subscription.id, server.apiKey)).status).toBe(200);
  expect((await updateSubscription(systemSubscription.id, systemAccountApiKey)).status).toBe(200);
  expect((await api(`/v1/subscriptions/${subscription.id}`, { method: "DELETE" })).status).toBe(
    200,
  );
  expect(
    (
      await api(
        `/v1/subscriptions/${systemSubscription.id}`,
        { method: "DELETE" },
        systemAccountApiKey,
      )
    ).status,
  ).toBe(200);
  expect((await api(`/v1/webhooks/inbound/${inbound.id}`, { method: "DELETE" })).status).toBe(200);
  expect(
    (
      await api(
        `/v1/webhooks/inbound/${systemInbound.id}`,
        { method: "DELETE" },
        systemAccountApiKey,
      )
    ).status,
  ).toBe(200);

  await _drainAuditWritesForTests();
  const rows = await server.db
    .select({
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      action: auditLog.action,
      resource_id: auditLog.resource_id,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        inArray(auditLog.resource_id, [
          inbound.id,
          systemInbound.id,
          subscription.id,
          systemSubscription.id,
          String(userEvent.event_id),
          String(systemEvent.event_id),
        ]),
      ),
    );
  expect(rows).toEqual(
    expect.arrayContaining([
      {
        actor_type: "user",
        actor_id: server.userId,
        action: "event.emitted",
        resource_id: String(userEvent.event_id),
      },
      {
        actor_type: "system_account",
        actor_id: server.systemAccountId,
        action: "event.emitted",
        resource_id: String(systemEvent.event_id),
      },
      {
        actor_type: "user",
        actor_id: server.userId,
        action: "webhook.outbound.replayed",
        resource_id: subscription.id,
      },
      {
        actor_type: "system_account",
        actor_id: server.systemAccountId,
        action: "webhook.outbound.replayed",
        resource_id: systemSubscription.id,
      },
      {
        actor_type: "user",
        actor_id: server.userId,
        action: "webhook.inbound.created",
        resource_id: inbound.id,
      },
      {
        actor_type: "user",
        actor_id: server.userId,
        action: "webhook.inbound.deleted",
        resource_id: inbound.id,
      },
      {
        actor_type: "user",
        actor_id: server.userId,
        action: "subscription.created",
        resource_id: subscription.id,
      },
      {
        actor_type: "user",
        actor_id: server.userId,
        action: "subscription.updated",
        resource_id: subscription.id,
      },
      {
        actor_type: "user",
        actor_id: server.userId,
        action: "subscription.deleted",
        resource_id: subscription.id,
      },
      {
        actor_type: "system_account",
        actor_id: server.systemAccountId,
        action: "webhook.inbound.created",
        resource_id: systemInbound.id,
      },
      {
        actor_type: "system_account",
        actor_id: server.systemAccountId,
        action: "webhook.inbound.deleted",
        resource_id: systemInbound.id,
      },
      {
        actor_type: "system_account",
        actor_id: server.systemAccountId,
        action: "subscription.created",
        resource_id: systemSubscription.id,
      },
      {
        actor_type: "system_account",
        actor_id: server.systemAccountId,
        action: "subscription.updated",
        resource_id: systemSubscription.id,
      },
      {
        actor_type: "system_account",
        actor_id: server.systemAccountId,
        action: "subscription.deleted",
        resource_id: systemSubscription.id,
      },
    ]),
  );
});
