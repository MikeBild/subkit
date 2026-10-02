// Integration tests for the connector re-auth feature wired into the
// execution layer.
//
// Each case runs a real workflow via runExecution against a live mock HTTP
// server. The DB is a disposable Postgres instance seeded by createEngineCtx.
//
// Coverage:
//   1. Reactive flag + single event: 401 response → needs_reauth=true + exactly
//      one connector.auth_failed event.
//   2. Storm dedup: hitting the same connector twice on 401 emits only ONE event.
//   3. Clear on success: a subsequent 200 clears the flag.
//   4. 404 does NOT flag: non-auth error codes must not touch needs_reauth.
//   5. Only a success the STORED credential earned clears: a step that sends
//      its own Authorization proves nothing about it.
//   6. A GraphQL step walks the same clearing edge as an HTTP step.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { markConnectorNeedsReauth } from "../../connectors/reauth.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, events } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let connectorId: string;
let graphqlConnectorId: string;
/** What the GraphQL endpoint answers with; flipped per test. */
let graphqlReply: unknown = { data: { viewer: { id: "1" } } };

async function storeBearer(connector_id: string): Promise<void> {
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id,
      environment: "dev",
      mode: "bearer",
      // A fixture marker, not a credential.
      value: { mode: "bearer", token: "fixture-stored-token-not-real" },
      actor_id: null,
    },
    ctx.testDb.db,
  );
}

beforeAll(async () => {
  ctx = await createEngineCtx("connector-reauth");

  mock = await createMockServer((req, res) => {
    if (req.url?.startsWith("/unauth")) {
      jsonResponse(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.url?.startsWith("/forbidden")) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    if (req.url?.startsWith("/notfound")) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }
    if (req.url?.startsWith("/graphql")) {
      jsonResponse(res, 200, graphqlReply);
      return;
    }
    jsonResponse(res, 200, { ok: true });
  });

  // Seed an HTTP connector pointing at the mock server.
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "reauth-mock",
      display_name: "Reauth Mock",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  connectorId = c!.id;
  // The flag is about this credential: a success clears it only when this is
  // what authenticated the request.
  await storeBearer(connectorId);

  const [g] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "reauth-graphql-mock",
      display_name: "Reauth GraphQL Mock",
      driver: "graphql",
      environment: "dev",
      auth_type: "bearer",
      base_url: `${mock.baseUrl}/graphql`,
      config: {},
    })
    .returning();
  graphqlConnectorId = g!.id;
  await storeBearer(graphqlConnectorId);
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function queryConnectorRow() {
  const rows = await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId));
  return rows[0]!;
}

async function queryAuthFailedEvents() {
  return ctx.testDb.db
    .select()
    .from(events)
    .where(and(eq(events.tenant_id, ctx.tenantId), eq(events.type, "connector.auth_failed")));
}

async function resetConnector() {
  // Reset state between tests that share the same connector row. The circuit
  // columns must reset too: each test here intentionally fails requests, and
  // the (now actually persisting) circuit breaker would otherwise open
  // mid-suite and block later tests with circuit_open instead of exercising
  // the reauth path under test.
  await ctx.testDb.db
    .update(connectors)
    .set({
      needs_reauth: false,
      auth_failed_at: null,
      auth_failed_reason: null,
      circuit_state: "closed",
      circuit_failure_count: 0,
      circuit_opened_at: null,
    })
    .where(eq(connectors.id, connectorId));
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("connector re-auth — reactive flag + event", () => {
  test("401 response flags needs_reauth=true and emits exactly one connector.auth_failed event", async () => {
    await resetConnector();

    const eventsBefore = await queryAuthFailedEvents();
    const eventCountBefore = eventsBefore.length;

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "reauth-flag-401",
      steps: [
        {
          kind: "request",
          id: "call",
          method: "GET",
          connector_id: connectorId,
          path: "/unauth",
          max_retries: 0,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("failed");

    // Connector row must be flagged.
    const connRow = await queryConnectorRow();
    expect(connRow.needs_reauth).toBe(true);
    expect(connRow.auth_failed_at).not.toBeNull();
    expect(typeof connRow.auth_failed_reason).toBe("string");
    expect(connRow.auth_failed_reason!.length).toBeGreaterThan(0);

    // Exactly one new connector.auth_failed event must be emitted.
    const eventsAfter = await queryAuthFailedEvents();
    const newEvents = eventsAfter.slice(eventCountBefore);
    expect(newEvents.length).toBe(1);

    // CRITICAL: the event must be on the `notification.emitted` channel — that
    // is the only channel index.ts wires into the fanout queue, so this is what
    // makes the notification actually reach the dispatcher (a regression to
    // `event.emitted` would silently drop every connector-auth notification).
    expect(newEvents[0]!.channel).toBe("notification.emitted");

    const payload = newEvents[0]!.payload as {
      connector_id?: string;
      reauth_url?: string | null;
      severity?: string;
    };
    expect(payload.connector_id).toBe(connectorId);
    expect(payload.severity).toBe("error");
    // reauth_url may be null when no public origin is configured (test env);
    // it must be present in the payload regardless.
    expect("reauth_url" in payload).toBe(true);
  });

  // This used to assert the opposite. A 403 is "this identity may not touch
  // THIS resource" — a wrong id in a path, a scope the grant never covered —
  // while the credential is alive. Flagging on it took a healthy connector out
  // of service: every step on it became unavailable, its schedule was held, and
  // the prepared run that would have cleared the flag was refused for the same
  // reason. Probe classification and the proactive scan already made this
  // split (401 credential_invalid, 403 scope_insufficient); dispatch now does.
  test("a 403 fails the run but leaves the connector in service", async () => {
    await resetConnector();

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "reauth-flag-403",
      steps: [
        {
          kind: "request",
          id: "call",
          method: "GET",
          connector_id: connectorId,
          path: "/forbidden",
          max_retries: 0,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("failed");

    const connRow = await queryConnectorRow();
    expect(connRow.needs_reauth).toBe(false);
  });
});

describe("connector re-auth — storm dedup (false→true edge only)", () => {
  test("two consecutive 401 runs on the same connector emit exactly one event total", async () => {
    await resetConnector();

    const eventsBefore = await queryAuthFailedEvents();
    const eventCountBefore = eventsBefore.length;

    // First run — transitions false→true, emits event.
    const { workflow_id: wf1 } = await createWorkflowRow(ctx, {
      name: "dedup-run-1",
      steps: [
        {
          kind: "request",
          id: "call",
          method: "GET",
          connector_id: connectorId,
          path: "/unauth",
          max_retries: 0,
        },
      ],
    });
    await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: wf1 },
      input: null,
    });

    // Second run — connector is already flagged; must NOT emit a second event.
    const { workflow_id: wf2 } = await createWorkflowRow(ctx, {
      name: "dedup-run-2",
      steps: [
        {
          kind: "request",
          id: "call2",
          method: "GET",
          connector_id: connectorId,
          path: "/unauth",
          max_retries: 0,
        },
      ],
    });
    await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: wf2 },
      input: null,
    });

    const eventsAfter = await queryAuthFailedEvents();
    const newEventCount = eventsAfter.length - eventCountBefore;
    expect(newEventCount).toBe(1);

    // Connector stays flagged.
    const connRow = await queryConnectorRow();
    expect(connRow.needs_reauth).toBe(true);
    // The flag is the whole report. A rejected credential is an answer from
    // the remote, so neither 401 counts toward the circuit breaker — counting
    // them used to open it and replace "reconnect" with `circuit_open`.
    expect(connRow.circuit_failure_count).toBe(0);
    expect(connRow.circuit_state).toBe("closed");
  });
});

describe("connector re-auth — clear on success", () => {
  test("a successful 200 request clears the needs_reauth flag", async () => {
    // Ensure connector is flagged before the test.
    await resetConnector();
    const { workflow_id: failWf } = await createWorkflowRow(ctx, {
      name: "clear-setup-fail",
      steps: [
        {
          kind: "request",
          id: "fail",
          method: "GET",
          connector_id: connectorId,
          path: "/unauth",
          max_retries: 0,
        },
      ],
    });
    await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: failWf },
      input: null,
    });

    // Verify it is flagged.
    const flagged = await queryConnectorRow();
    expect(flagged.needs_reauth).toBe(true);

    // Now run a successful request on the same connector.
    const { workflow_id: successWf } = await createWorkflowRow(ctx, {
      name: "clear-on-success",
      steps: [
        {
          kind: "request",
          id: "ok",
          method: "GET",
          connector_id: connectorId,
          path: "/ok",
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: successWf },
      input: null,
    });

    expect(result.status).toBe("succeeded");

    // Flag must be cleared.
    const cleared = await queryConnectorRow();
    expect(cleared.needs_reauth).toBe(false);
    expect(cleared.auth_failed_at).toBeNull();
  });
});

describe("connector re-auth — non-auth errors do not flag", () => {
  test("404 response does NOT set needs_reauth=true", async () => {
    await resetConnector();

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "no-flag-404",
      steps: [
        {
          kind: "request",
          id: "notfound",
          method: "GET",
          connector_id: connectorId,
          path: "/notfound",
          max_retries: 0,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("failed");

    const connRow = await queryConnectorRow();
    expect(connRow.needs_reauth).toBe(false);
    expect(connRow.auth_failed_at).toBeNull();
  });
});

describe("connector re-auth — only the stored credential's success clears", () => {
  async function flag(connector_id: string): Promise<void> {
    await ctx.testDb.db
      .update(connectors)
      .set({ needs_reauth: false, circuit_state: "closed", circuit_failure_count: 0 })
      .where(eq(connectors.id, connector_id));
    await markConnectorNeedsReauth(ctx.testDb.db, ctx.tenantId, connector_id, "seeded");
  }

  async function needsReauth(connector_id: string): Promise<boolean> {
    const [row] = await ctx.testDb.db
      .select({ needs_reauth: connectors.needs_reauth })
      .from(connectors)
      .where(eq(connectors.id, connector_id));
    return row!.needs_reauth;
  }

  async function run(name: string, step: Record<string, unknown>) {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name,
      steps: [{ kind: "request", id: "call", max_retries: 0, ...step }],
    });
    return runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
  }

  test("an HTTP step that sends its own Authorization leaves the flag standing", async () => {
    await flag(connectorId);
    const result = await run("reauth-step-own-authorization", {
      method: "GET",
      connector_id: connectorId,
      path: "/ok",
      headers: { Authorization: "Bearer fixture-step-token-not-real" },
    });
    expect(result.status).toBe("succeeded");
    expect(await needsReauth(connectorId)).toBe(true);
  });

  test("a successful GraphQL step clears the flag", async () => {
    graphqlReply = { data: { viewer: { id: "1" } } };
    await flag(graphqlConnectorId);
    const result = await run("reauth-graphql-clears", {
      connector_id: graphqlConnectorId,
      graphql: { query: "{ viewer { id } }" },
    });
    expect(result.status).toBe("succeeded");
    expect(await needsReauth(graphqlConnectorId)).toBe(false);
  });

  test("a GraphQL step answered with errors does not", async () => {
    graphqlReply = { data: null, errors: [{ message: "unauthenticated" }] };
    await flag(graphqlConnectorId);
    const result = await run("reauth-graphql-errors", {
      connector_id: graphqlConnectorId,
      graphql: { query: "{ viewer { id } }" },
    });
    expect(result.status).toBe("failed");
    expect(await needsReauth(graphqlConnectorId)).toBe(true);
  });
});
