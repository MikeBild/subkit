import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, events } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import type { StepErrorDetail } from "../types.ts";
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

const SUNSET = "Sat, 31 Jan 2026 23:59:59 GMT";

beforeAll(async () => {
  ctx = await createEngineCtx("endpoint-contract");

  mock = await createMockServer((req, res) => {
    if (req.url?.startsWith("/rest/api/3/search")) {
      res.statusCode = 410;
      res.setHeader("content-type", "application/json");
      res.setHeader("deprecation", "true");
      res.setHeader("sunset", SUNSET);
      res.setHeader(
        "link",
        '<https://example.test/rest/api/3/search/jql>; rel="successor-version"',
      );
      res.end(JSON.stringify({ errorMessages: ["The requested resource is no longer available"] }));
      return;
    }
    if (req.url?.startsWith("/deprecated-ok")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("deprecation", "true");
      res.setHeader("sunset", SUNSET);
      res.end(JSON.stringify({ issues: [{ key: "X-1" }] }));
      return;
    }
    if (req.url?.startsWith("/orgs/")) {
      jsonResponse(res, 404, { message: "Not Found" });
      return;
    }
    jsonResponse(res, 200, { ok: true });
  });

  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "contract-mock",
      display_name: "Contract Mock",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  connectorId = c!.id;
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function runStep(name: string, path: string) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name,
    steps: [
      {
        kind: "request",
        id: "call",
        method: "GET",
        connector_id: connectorId,
        path,
        max_retries: 0,
      },
    ],
  });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
  });
}

async function connectorRow() {
  const rows = await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId));
  return rows[0]!;
}

async function resetHealth() {
  await ctx.testDb.db
    .update(connectors)
    .set({
      health_state: "ok",
      health_reason: null,
      health_error_code: null,
      sunset_at: null,
      successor_uri: null,
    })
    .where(eq(connectors.id, connectorId));
}

async function healthChangedEvents() {
  return ctx.testDb.db
    .select()
    .from(events)
    .where(and(eq(events.tenant_id, ctx.tenantId), eq(events.type, "connector.health_changed")));
}

describe("endpoint contract — removed endpoint (410)", () => {
  test("step.failed carries actionable guidance + connector flips to needs_update with successor URI", async () => {
    await resetHealth();
    const result = await runStep("contract-410", "/rest/api/3/search?jql=project%3DX");
    expect(result.status).toBe("failed");

    const error = result.steps[0]?.error as StepErrorDetail | undefined;
    expect(error?.message).toBe("http 410");
    expect(error?.upstream_status).toBe(410);
    expect(error?.health).toBe("endpoint_gone");
    expect(error?.health_error_code).toBe("endpoint_removed");
    expect(error?.guidance).toContain("removed");
    expect(error?.guidance).toContain("https://example.test/rest/api/3/search/jql");
    expect(error?.next_best_actions).toContain("fetch_connector_docs");

    const row = await connectorRow();
    expect(row.health_state).toBe("needs_update");
    expect(row.health_error_code).toBe("endpoint_removed");
    expect(row.successor_uri).toBe("https://example.test/rest/api/3/search/jql");
    expect(row.sunset_at).not.toBeNull();
  });

  test("repeated 410 runs do not storm: exactly one health_changed event", async () => {
    const before = (await healthChangedEvents()).length;
    await runStep("contract-410-again", "/rest/api/3/search?jql=project%3DY");
    await runStep("contract-410-third", "/rest/api/3/search?jql=project%3DZ");
    expect((await healthChangedEvents()).length).toBe(before);
  });

  test("needs_update does NOT auto-clear when an unrelated path succeeds", async () => {
    const result = await runStep("contract-ok-other", "/ok");
    expect(result.status).toBe("succeeded");
    expect((await connectorRow()).health_state).toBe("needs_update");
  });
});

describe("endpoint contract — deprecation early warning (2xx + Sunset)", () => {
  test("a SUCCESSFUL response with Deprecation/Sunset flags needs_update before any 410", async () => {
    await resetHealth();
    const before = (await healthChangedEvents()).length;

    const result = await runStep("contract-deprecated", "/deprecated-ok");
    expect(result.status).toBe("succeeded");

    const row = await connectorRow();
    expect(row.health_state).toBe("needs_update");
    expect(row.health_error_code).toBe("endpoint_deprecated");
    expect(row.sunset_at).not.toBeNull();

    const evs = await healthChangedEvents();
    expect(evs.length - before).toBe(1);
    const payload = evs.at(-1)!.payload as { severity?: string; error_code?: string };
    expect(payload.severity).toBe("warn");
    expect(payload.error_code).toBe("endpoint_deprecated");
  });
});

describe("endpoint contract — 404 path guidance", () => {
  test("404 on /orgs/{x} carries the user-vs-org fallback hint", async () => {
    await resetHealth();
    const result = await runStep("contract-404-org", "/orgs/octocat/repos");
    expect(result.status).toBe("failed");

    const error = result.steps[0]?.error as StepErrorDetail | undefined;
    expect(error?.health).toBe("not_found");
    expect(error?.guidance).toContain("/users/octocat/repos");

    expect((await connectorRow()).health_state).toBe("ok");
  });
});
