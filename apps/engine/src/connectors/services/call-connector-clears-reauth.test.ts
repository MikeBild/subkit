import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import { auditLog, connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import {
  type AuthenticatedCallOutcome,
  callProvedCredentialLive,
  markConnectorNeedsReauth,
  requestUsedStoredCredential,
} from "../reauth.ts";
import { createConnector } from "../service.ts";
import { type CallConnectorRequest, callConnector } from "./call-connector.ts";

let ctx: TestDb;
let tenantId: string;
let mock: MockServer;
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

function call(connector_id: string, extra: Partial<CallConnectorRequest> = {}) {
  return callConnector({
    db: ctx.db,
    tenant_id: tenantId,
    actor_id: null,
    connector_id,
    method: "GET",
    path: "/items",
    ...extra,
  });
}

describe("callConnector — re-auth clearing edge", () => {
  test("preserves a known user actor type on direct connector invocation", async () => {
    upstreamStatus = 200;
    const connector_id = await seedFlaggedConnector("call-preserves-actor-type");
    const actor_id = "bde323c4-8447-45b1-8aef-05cf93cc6e9a";
    const result = await call(connector_id, { actor_id, actor_type: "user" });
    expect(result.kind).toBe("ok");
    const [entry] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "connector.invoked"),
          eq(auditLog.resource_id, connector_id),
          eq(auditLog.actor_id, actor_id),
        ),
      );
    expect(entry).toEqual({ actor_type: "user", actor_id });
  });

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
    expect(result.kind).toBe("ok");
    expect(await readFlag(connector_id)).toBe(true);
  });

  test.each([
    ["Authorization", "capitalized"],
    ["authorization", "lowercase"],
  ])(
    "a caller's %s cannot replace the stored credential or clear reauth",
    async (header, label) => {
      upstreamStatus = 200;
      const connector_id = await seedFlaggedConnector(`call-keeps-on-caller-auth-${label}`);
      const before = mock.callCount();
      const result = await call(connector_id, {
        headers: { [header]: "Bearer fixture-caller-token-not-real" },
      });
      expect(result).toMatchObject({
        kind: "error",
        error_code: "call_failed",
        message: "request headers conflict with connector authentication",
      });
      expect(mock.callCount()).toBe(before);
      expect(await readFlag(connector_id)).toBe(true);
    },
  );

  test("a 2xx from an absolute URL on another host proves nothing either", async () => {
    upstreamStatus = 200;
    const other = await createMockServer((_req: IncomingMessage, res: ServerResponse) => {
      jsonResponse(res, 200, { ok: true });
    });
    try {
      const connector_id = await seedFlaggedConnector("call-keeps-on-other-host");
      const result = await call(connector_id, { path: `${other.baseUrl}/items` });
      expect(result.kind).toBe("ok");
      expect(other.callCount()).toBe(1);
      expect(await readFlag(connector_id)).toBe(true);
    } finally {
      await other.close();
    }
  });
});

describe("callConnector — a disabled connector", () => {
  test("is refused as connector_disabled and nothing is sent", async () => {
    upstreamStatus = 200;
    const connector_id = await seedFlaggedConnector("call-refused-when-disabled");
    await ctx.db.update(connectors).set({ enabled: false }).where(eq(connectors.id, connector_id));
    const before = mock.callCount();

    const result = await call(connector_id);

    expect(result).toMatchObject({
      kind: "error",
      error_code: "connector_disabled",
      metadata: {
        connector_id,
        connector_slug: "call-refused-when-disabled",
        environment: "dev",
        reason: "disabled",
      },
    });
    expect(mock.callCount()).toBe(before);
    expect(await readFlag(connector_id)).toBe(true);
  });
});

describe("callProvedCredentialLive", () => {
  const flagged = { auth_type: "bearer", needs_reauth: true } as const;
  const outcome = (over: Partial<AuthenticatedCallOutcome> = {}): AuthenticatedCallOutcome => ({
    status: 200,
    health: "ok",
    stored_credential_used: true,
    ...over,
  });

  test("a 2xx on a flagged, authenticating connector is proof", () => {
    expect(callProvedCredentialLive(flagged, outcome())).toBe(true);
    expect(callProvedCredentialLive(flagged, outcome({ status: 204 }))).toBe(true);
    expect(callProvedCredentialLive(flagged, outcome({ health: "deprecated" }))).toBe(true);
    expect(callProvedCredentialLive(flagged, outcome({ body: { data: { ok: true } } }))).toBe(true);
  });

  test("a 200 that only looks like success is not", () => {
    expect(callProvedCredentialLive(flagged, outcome({ health: "auth_failed" }))).toBe(false);
    expect(
      callProvedCredentialLive(
        flagged,
        outcome({ body: { data: null, errors: [{ message: "unauthenticated" }] } }),
      ),
    ).toBe(false);
  });

  test("a success the stored credential did not earn is not", () => {
    expect(callProvedCredentialLive(flagged, outcome({ stored_credential_used: false }))).toBe(
      false,
    );
  });

  test("neither is a failure, nor a call that never completed", () => {
    expect(callProvedCredentialLive(flagged, outcome({ status: 401, health: "auth_failed" }))).toBe(
      false,
    );
    expect(callProvedCredentialLive(flagged, outcome({ status: 500, health: "degraded" }))).toBe(
      false,
    );
    expect(callProvedCredentialLive(flagged, outcome({ status: 0 }))).toBe(false);
  });

  test("a connector that sends no credential proves nothing about one", () => {
    expect(callProvedCredentialLive({ auth_type: "none", needs_reauth: true }, outcome())).toBe(
      false,
    );
  });

  test("an unflagged connector has nothing to clear", () => {
    expect(callProvedCredentialLive({ auth_type: "bearer", needs_reauth: false }, outcome())).toBe(
      false,
    );
  });
});

describe("requestUsedStoredCredential", () => {
  const home = "https://api.acme.test/v2";
  const url = new URL("https://api.acme.test/v2/items");
  const bearer = { mode: "bearer", token: "fixture-stored-token-not-real" } as const;

  test("the stored credential at the connector's own host is what authenticated", () => {
    expect(requestUsedStoredCredential({ credential: bearer, home, url })).toBe(true);
    expect(
      requestUsedStoredCredential({
        credential: bearer,
        home,
        url,
        caller_headers: { Accept: "application/json", "X-Request-Id": "1" },
        caller_query: { limit: 2 },
      }),
    ).toBe(true);
  });

  test.each(["Authorization", "authorization", "Proxy-Authorization", "Cookie"])(
    "a caller's %s header takes its place",
    (name) => {
      expect(
        requestUsedStoredCredential({
          credential: bearer,
          home,
          url,
          caller_headers: { [name]: "fixture-caller-value-not-real" },
        }),
      ).toBe(false);
    },
  );

  test("a request to another host was not authenticated for this connector", () => {
    expect(
      requestUsedStoredCredential({
        credential: bearer,
        home,
        url: new URL("https://api.elsewhere.test/v2/items"),
      }),
    ).toBe(false);
    expect(requestUsedStoredCredential({ credential: bearer, home: null, url })).toBe(false);
  });

  test("a caller's header under the credential's own name shadows it, in any case", () => {
    const credential = { mode: "header", headers: { "X-Session-Id": "fixture-not-real" } } as const;
    expect(
      requestUsedStoredCredential({
        credential,
        home,
        url,
        caller_headers: { "x-session-id": "fixture-caller-value-not-real" },
      }),
    ).toBe(false);
    expect(
      requestUsedStoredCredential({ credential, home, url, caller_headers: { "X-Trace": "1" } }),
    ).toBe(true);
  });

  test("a caller's query parameter under the credential's own name shadows it", () => {
    const credential = { mode: "query", query: { sig: "fixture-not-real" } } as const;
    expect(
      requestUsedStoredCredential({ credential, home, url, caller_query: { sig: "caller" } }),
    ).toBe(false);
    expect(requestUsedStoredCredential({ credential, home, url, caller_query: { limit: 2 } })).toBe(
      true,
    );
  });

  test("no credential, or one that sends nothing, authenticates nothing", () => {
    expect(requestUsedStoredCredential({ credential: null, home, url })).toBe(false);
    expect(requestUsedStoredCredential({ credential: { mode: "none" }, home, url })).toBe(false);
  });
});
