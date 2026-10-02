// A successful `call_connector` closes the re-auth state machine's clearing edge.
//
// `connectors/reauth.ts` documents the machine as
//   healthy ──auth failure──▶ needs_reauth=true
//   needs_reauth=true ──successful authed call──▶ healthy
// A request step and a probe each walk the second edge. A direct call reaches
// the remote through neither, so an operator who called a flagged connector,
// got a 200 with the stored credential and saw real data still read "must be
// reconnected" on it — the call had proved the opposite and nothing said so.
//
// These tests pin the edge and its guards: a rejected call proves nothing, and
// neither does a call on a connector that sends no credential.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { callProvedCredentialLive, markConnectorNeedsReauth } from "../reauth.ts";
import { createConnector } from "../service.ts";
import { callConnector } from "./call-connector.ts";

let ctx: TestDb;
let tenantId: string;
let mock: MockServer;
/** Flipped per test so one fixture can answer healthy or reject the credential. */
let upstreamStatus = 200;

beforeAll(async () => {
  ctx = await createTestDb("call-connector-clears-reauth");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "call-clears-reauth", display_name: "Call clears reauth" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  mock = await createMockServer((_req: IncomingMessage, res: ServerResponse) => {
    jsonResponse(res, upstreamStatus, upstreamStatus === 200 ? { ok: true } : { error: "nope" });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

/** A flagged bearer connector with a real stored credential. */
async function seedFlaggedConnector(name: string): Promise<string> {
  const created = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name,
        driver: "http",
        environment: "dev",
        base_url: mock.baseUrl,
        auth_type: "bearer",
        config: {},
      },
      actor_id: null,
    },
    ctx.db,
  );
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: created.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "stored-token" },
      actor_id: null,
    },
    ctx.db,
  );
  const { transitioned } = await markConnectorNeedsReauth(
    ctx.db,
    tenantId,
    created.id,
    "seeded for this test",
  );
  expect(transitioned).toBe(true);
  return created.id;
}

async function readFlag(connector_id: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ needs_reauth: connectors.needs_reauth })
    .from(connectors)
    .where(eq(connectors.id, connector_id));
  if (!row) throw new Error("connector row missing");
  return row.needs_reauth;
}

function call(connector_id: string) {
  return callConnector({
    db: ctx.db,
    tenant_id: tenantId,
    actor_id: null,
    connector_id,
    method: "GET",
    path: "/items",
  });
}

describe("callConnector — re-auth clearing edge", () => {
  test("a 2xx with the stored credential clears needs_reauth", async () => {
    upstreamStatus = 200;
    const connector_id = await seedFlaggedConnector("call-clears-on-success");
    const result = await call(connector_id);
    expect(result.kind).toBe("ok");
    expect(await readFlag(connector_id)).toBe(false);
  });

  test("a rejected call leaves the flag standing — it is not proof the credential is live", async () => {
    upstreamStatus = 401;
    const connector_id = await seedFlaggedConnector("call-keeps-on-401");
    const result = await call(connector_id);
    // The call completed at the transport layer; the envelope carries the 401.
    expect(result.kind).toBe("ok");
    expect(await readFlag(connector_id)).toBe(true);
  });
});

describe("callProvedCredentialLive", () => {
  const flagged = { auth_type: "bearer", needs_reauth: true } as const;

  test("a 2xx on a flagged, authenticating connector is proof", () => {
    expect(callProvedCredentialLive(flagged, 200, "ok")).toBe(true);
    expect(callProvedCredentialLive(flagged, 204, "ok")).toBe(true);
    // A deprecation notice rides on a response that did succeed.
    expect(callProvedCredentialLive(flagged, 200, "deprecated")).toBe(true);
  });

  test("a 200 that only looks like success is not", () => {
    // An anonymous 200 is the remote serving a caller it did not recognise.
    expect(callProvedCredentialLive(flagged, 200, "auth_failed")).toBe(false);
  });

  test("neither is a failure, nor a call that never completed", () => {
    expect(callProvedCredentialLive(flagged, 401, "auth_failed")).toBe(false);
    expect(callProvedCredentialLive(flagged, 500, "degraded")).toBe(false);
    expect(callProvedCredentialLive(flagged, 0, "ok")).toBe(false);
  });

  test("a connector that sends no credential proves nothing about one", () => {
    expect(callProvedCredentialLive({ auth_type: "none", needs_reauth: true }, 200, "ok")).toBe(
      false,
    );
  });

  test("an unflagged connector has nothing to clear", () => {
    expect(callProvedCredentialLive({ auth_type: "bearer", needs_reauth: false }, 200, "ok")).toBe(
      false,
    );
  });
});
