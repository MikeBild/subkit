import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { PubSubEmitter } from "../../pubsub/emitter.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { registerResourcesCapability } from "./resources.ts";

let ctx: EngineTestCtx;
const resourceId = "00000000-0000-4000-8000-000000000081";
const foreignTenant = "00000000-0000-4000-8000-000000000082";
const uris = [
  `connector://${resourceId}`,
  `knowledge://${resourceId}`,
  `skill-candidate://${resourceId}`,
];

beforeAll(async () => {
  ctx = await createEngineCtx("resource-subscription-isolation");
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

function principal(tenant = ctx.tenantId): ResolvedPrincipal {
  return { tenant_id: tenant, id: resourceId, provider: "test", kind: "user", roles: ["admin"] };
}

async function session(owner: ResolvedPrincipal, emitter: PubSubEmitter) {
  const server = new Server({ name: "resource-isolation-test", version: "0.0.0" });
  registerResourcesCapability({ server, db: ctx.testDb.db, principal: owner, emitter });
  const client = new Client({ name: "resource-isolation-client", version: "0.0.0" });
  const received: string[] = [];
  let listChanged = 0;
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (event) => {
    received.push(event.params.uri);
  });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
    listChanged++;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    received,
    lists: () => listChanged,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function emit(emitter: PubSubEmitter, tenant_id = ctx.tenantId) {
  await emitter.dispatch({
    id: 1,
    tenant_id,
    channel: "connector.oauth",
    type: "connector.oauth.refreshed",
    payload: { connector_id: resourceId },
    created_at: new Date(FROZEN_NOW),
  });
  await emitter.dispatch({
    id: 2,
    tenant_id,
    channel: "notification.emitted",
    type: "notification.emitted",
    payload: { knowledge_source_id: resourceId, skill_candidate_id: resourceId },
    created_at: new Date(FROZEN_NOW),
  });
}

test("product subscriptions expose no operator updates or resource-list change events", async () => {
  const emitter = new PubSubEmitter();
  const product = await session({ ...principal(), product_id: "harmoniqs" }, emitter);
  const operator = await session(principal(), emitter);
  try {
    for (const uri of uris) {
      await product.client.subscribeResource({ uri });
      await operator.client.subscribeResource({ uri });
    }
    await emit(emitter);
    await waitFor(() => operator.lists() > 0, { sleepMs: 10 });
    expect(operator.received).toEqual(uris);
    expect(product.received).toEqual([]);
    expect(product.lists()).toBe(0);
  } finally {
    await product.close();
    await operator.close();
  }
});

test("resource subscriptions and forwarding obey current credential read ceilings", async () => {
  const emitter = new PubSubEmitter();
  const restrictedPrincipal = { ...principal(), scopes: ["connector:read"] };
  const restricted = await session(restrictedPrincipal, emitter);
  const operator = await session(principal(), emitter);
  try {
    for (const uri of uris) {
      await restricted.client.subscribeResource({ uri });
      await operator.client.subscribeResource({ uri });
    }
    restrictedPrincipal.scopes = ["workflow:run"];
    await emit(emitter);
    await waitFor(() => operator.lists() > 0, { sleepMs: 10 });
    expect(operator.received).toEqual(uris);
    expect(restricted.received).toEqual([]);
    expect(restricted.lists()).toBe(0);
  } finally {
    await restricted.close();
    await operator.close();
  }
});

test("foreign tenant events expose neither resource updates nor list-change activity", async () => {
  const emitter = new PubSubEmitter();
  const local = await session(principal(), emitter);
  const foreign = await session(principal(foreignTenant), emitter);
  try {
    for (const uri of uris) {
      await local.client.subscribeResource({ uri });
      await foreign.client.subscribeResource({ uri });
    }
    await emit(emitter, foreignTenant);
    await waitFor(() => foreign.lists() > 0, { sleepMs: 10 });
    expect(foreign.received).toEqual(uris);
    expect(local.received).toEqual([]);
    expect(local.lists()).toBe(0);
  } finally {
    await local.close();
    await foreign.close();
  }
});
