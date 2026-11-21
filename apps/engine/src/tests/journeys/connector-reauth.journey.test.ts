import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let upstream: Server;
let acceptedKey = "key-one";
let connectorId = "";
let workflowId = "";

interface AttentionItem {
  id: string;
  reason: string;
  actions: Array<{ verb: string }>;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("core-connector-reauth");
  upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers["x-api-key"] !== acceptedKey) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "invalid key" }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ items: [{ id: 1, name: "first" }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const created = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      name: "Inventory",
      slug: "inventory",
      driver: "http",
      environment: "prod",
      auth_type: "header",
      base_url: base,
    }),
  });
  expect(created.status).toBe(201);
  connectorId = ((await created.json()) as { id: string }).id;

  const workflow = await seedWorkflow(ctx, {
    slug: "list-inventory",
    name: "List inventory",
    steps: [
      { id: "list", kind: "request", connector_id: connectorId, method: "GET", path: "/items" },
    ],
  });
  workflowId = workflow.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

function storeKey(key: string) {
  return journeyFetch(ctx, `/v1/connectors/${connectorId}/credentials`, {
    method: "POST",
    body: JSON.stringify({ mode: "header", headers: { "x-api-key": key } }),
  });
}

async function testConnector(): Promise<{ ok: boolean; status?: number }> {
  const res = await journeyFetch(ctx, `/v1/connectors/${connectorId}/test`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; status?: number };
}

async function run(): Promise<{
  status: number;
  body: { status?: string; execution_id?: string };
}> {
  const res = await journeyFetch(ctx, "/v1/executions", {
    method: "POST",
    body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { status?: string; execution_id?: string },
  };
}

async function connectorAttention(): Promise<AttentionItem | undefined> {
  const res = await journeyFetch(ctx, "/v1/attention");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: AttentionItem[] };
  return body.items.find((item) => item.id === `connector:${connectorId}`);
}

async function connectorState(): Promise<{ needs_reauth: boolean }> {
  const res = await journeyFetch(ctx, `/v1/connectors/${connectorId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { needs_reauth: boolean };
}

describe("a connector that lost its sign-in is repaired by the person", () => {
  test("a stored key makes the connector healthy and a run succeeds", async () => {
    expect((await storeKey("key-one")).status).toBe(201);
    expect((await testConnector()).ok).toBe(true);
    const first = await run();
    expect(first.body.status).toBe("succeeded");
    expect(await connectorAttention()).toBeUndefined();
  });

  test("the provider revokes the key: the run fails and the connector asks for sign-in", async () => {
    acceptedKey = "key-two";
    const failed = await run();
    expect(failed.body.status).toBe("failed");
    const detail = await journeyFetch(ctx, `/v1/executions/${failed.body.execution_id}`);
    const outcome = ((await detail.json()) as { outcome: { cause_class: string | null } }).outcome;
    expect(outcome.cause_class).toBe("auth_failed");
    expect((await connectorState()).needs_reauth).toBe(true);
    const item = await connectorAttention();
    expect(item?.reason).toBe("needs_reauth");
    expect(item?.actions.map((a) => a.verb)).toContain("reauth");
    const probe = await testConnector();
    expect(probe.ok).toBe(false);
    expect(probe.status).toBe(401);
  });

  test("the person stores the new key: healthy again and the item leaves the overview", async () => {
    expect((await storeKey("key-two")).status).toBe(201);
    expect((await connectorState()).needs_reauth).toBe(false);
    expect(await connectorAttention()).toBeUndefined();
    expect((await testConnector()).ok).toBe(true);
    const again = await run();
    expect(again.body.status).toBe("succeeded");
  });

  test("the audit records the stored credential and the cleared sign-in request", async () => {
    const res = await journeyFetch(ctx, "/v1/audit-log?limit=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        action: string;
        result: string;
        actor_id: string | null;
        resource_type: string | null;
        resource_id: string | null;
      }>;
    };
    const oldestFirst = [...body.items].reverse();
    const created = oldestFirst.find((row) => row.action === "credential.created");
    expect(created?.resource_type).toBe("credential");
    const replaced = oldestFirst.find(
      (row) => row.action === "credential.updated" && row.resource_id === created?.resource_id,
    );
    expect(replaced?.actor_id).toBe(ctx.userId);
    const cleared = oldestFirst.find(
      (row) => row.action === "connector.reauth_cleared" && row.resource_id === connectorId,
    );
    expect(cleared?.result).toBe("success");
    expect(cleared?.actor_id).toBe(ctx.userId);
  });
});
