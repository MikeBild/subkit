// `call_connector` as a chat/MCP tool, and the connector's re-auth flag.
//
// A successful call clears `needs_reauth` because it proves the stored
// credential live. That is only true of a call the stored credential
// authenticated: the tool merges caller headers on top of the connector's, a
// caller's `Authorization` replaces the stored one, and a full URL sends the
// request to whatever host the caller names. A 200 under any of those says
// nothing about the credential the flag is about — and neither does a GraphQL
// reply that carries its refusal in `errors`.
//
// The same file pins the switch: a disabled connector is refused by the tool
// exactly as a workflow step is, and nothing is sent.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { markConnectorNeedsReauth } from "../../../connectors/reauth.ts";
import { upsertCredential } from "../../../credentials/service.ts";
import { connectors } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { disabledConnectorRefusal } from "../../../execution/connector-availability.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import {
  createMockServer,
  jsonResponse,
  type MockServer,
} from "../../../test-helpers/mock-http.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import { callConnectorTool } from "../call-connector.ts";
import type { ToolContext } from "../index.ts";

// Fixture markers, not credentials.
const STORED_TOKEN = "fixture-stored-token-not-real";
const CALLER_TOKEN = "fixture-caller-token-not-real";

const nextUuid = createDeterministicUuidFactory(1);

let ctx: ConversationTestCtx;
let home: MockServer;
let elsewhere: MockServer;
let authorizationSeen: Array<string | undefined> = [];
/** What the GraphQL endpoint answers with; flipped per test. */
let graphqlReply: unknown = { data: { viewer: { id: "1" } } };

beforeAll(async () => {
  ctx = await createConversationTestCtx("call_connector_reauth");
  home = await createMockServer((req: IncomingMessage, res: ServerResponse) => {
    authorizationSeen.push(req.headers.authorization);
    jsonResponse(res, 200, req.url?.startsWith("/graphql") ? graphqlReply : { ok: true });
  });
  elsewhere = await createMockServer((_req: IncomingMessage, res: ServerResponse) => {
    jsonResponse(res, 200, { ok: true });
  });
}, 60_000);

afterAll(async () => {
  await home.close();
  await elsewhere.close();
  await ctx.cleanup();
}, 30_000);

function toolContext(): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: nextUuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

/** A bearer connector with a stored credential, flagged as needing re-auth. */
async function seedFlagged(slug: string, driver: "http" | "graphql" = "http"): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug,
      display_name: slug,
      driver,
      environment: "dev",
      auth_type: "bearer",
      base_url: driver === "graphql" ? `${home.baseUrl}/graphql` : home.baseUrl,
      config: {},
    })
    .returning();
  if (!row) throw new Error("seed connector failed");
  await upsertCredential(
    {
      tenant_id: ctx.tenant_id,
      connector_id: row.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: STORED_TOKEN },
      actor_id: null,
    },
    ctx.testDb.db,
  );
  const { transitioned } = await markConnectorNeedsReauth(
    ctx.testDb.db,
    ctx.tenant_id,
    row.id,
    "seeded for this test",
  );
  expect(transitioned).toBe(true);
  return row.id;
}

async function flagged(connector_id: string): Promise<boolean> {
  const [row] = await ctx.testDb.db
    .select({ needs_reauth: connectors.needs_reauth })
    .from(connectors)
    .where(eq(connectors.id, connector_id));
  if (!row) throw new Error("connector row missing");
  return row.needs_reauth;
}

describe("call_connector tool — the re-auth clearing edge", () => {
  test("a 2xx the stored credential earned clears the flag", async () => {
    authorizationSeen = [];
    const connector_id = await seedFlagged("reauth-stored");
    const result = await callConnectorTool.execute(toolContext(), {
      connector_id,
      method: "GET",
      path: "/items",
      query: { limit: 2 },
    });
    expect(result.ok).toBe(true);
    expect(authorizationSeen).toEqual([`Bearer ${STORED_TOKEN}`]);
    expect(await flagged(connector_id)).toBe(false);
  });

  test("a 2xx under the caller's own Authorization leaves the flag standing", async () => {
    authorizationSeen = [];
    const connector_id = await seedFlagged("reauth-caller-auth");
    const result = await callConnectorTool.execute(toolContext(), {
      connector_id,
      method: "GET",
      path: "/items",
      headers: { authorization: `Bearer ${CALLER_TOKEN}` },
    });
    expect(result.ok).toBe(true);
    // The upstream never saw the stored credential, so it proved nothing about it.
    expect(authorizationSeen).toEqual([`Bearer ${CALLER_TOKEN}`]);
    expect(await flagged(connector_id)).toBe(true);
  });

  test("a 2xx from another host leaves the flag standing", async () => {
    const connector_id = await seedFlagged("reauth-other-host");
    const before = elsewhere.callCount();
    const result = await callConnectorTool.execute(toolContext(), {
      connector_id,
      method: "GET",
      path: `${elsewhere.baseUrl}/items`,
    });
    expect(result.ok).toBe(true);
    expect(elsewhere.callCount()).toBe(before + 1);
    expect(await flagged(connector_id)).toBe(true);
  });

  test("a GraphQL 200 that carries errors leaves the flag standing", async () => {
    graphqlReply = { data: null, errors: [{ message: "unauthenticated" }] };
    const connector_id = await seedFlagged("reauth-graphql-errors", "graphql");
    const result = await callConnectorTool.execute(toolContext(), {
      connector_id,
      method: "POST",
      path: "/",
      body: { query: "{ viewer { id } }" },
    });
    expect((result.data as { status?: number }).status).toBe(200);
    expect(await flagged(connector_id)).toBe(true);
  });

  test("a GraphQL 200 with data and no errors clears it", async () => {
    graphqlReply = { data: { viewer: { id: "1" } } };
    const connector_id = await seedFlagged("reauth-graphql-data", "graphql");
    const result = await callConnectorTool.execute(toolContext(), {
      connector_id,
      method: "POST",
      path: "/",
      body: { query: "{ viewer { id } }" },
    });
    expect(result.ok).toBe(true);
    expect(await flagged(connector_id)).toBe(false);
  });
});

describe("call_connector tool — a disabled connector", () => {
  test("is refused as a workflow step is, and nothing is sent", async () => {
    const connector_id = await seedFlagged("reauth-disabled");
    const [row] = await ctx.testDb.db
      .update(connectors)
      .set({ enabled: false })
      .where(eq(connectors.id, connector_id))
      .returning();
    if (!row) throw new Error("connector row missing");
    const before = home.callCount();

    const result = await callConnectorTool.execute(toolContext(), {
      connector_id,
      method: "GET",
      path: "/items",
    });

    expect(result.ok).toBe(false);
    const data = result.data as { error: { code: string; message: string }; details: unknown };
    const stepRefusal = disabledConnectorRefusal(
      { ...row, environment: "dev", enabled: false },
      null,
    );
    expect(data.error.code).toBe(stepRefusal?.code ?? "");
    expect(data.details).toEqual(stepRefusal?.details);
    expect(data.error.message).toContain("is disabled");
    expect(home.callCount()).toBe(before);
    // A refusal proves nothing about the credential either.
    expect(await flagged(connector_id)).toBe(true);
  });
});
