// Unit tests for `registerResourcesCapability` portal-scope handling.
//
// The lifecycle dispatcher and the
// ListResources handler must both honour the `allowed_workflows`
// narrowing on a portal-scoped principal — narrowing only at read
// time leaks workflow names / slugs via list, and not re-checking RBAC
// at notification time lets a session subscribe to a URI it learned
// out-of-band and receive lifecycle pings it could not `readResource`.
//
// These tests bypass the streamable-HTTP harness and exercise the
// capability registration directly with a stubbed MCP `Server` so we
// can swap principals freely.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type {
  ListResourcesRequest,
  ListResourcesResult,
  SubscribeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/identity.ts";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { PubSubEmitter } from "../../pubsub/emitter.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { registerResourcesCapability } from "../capabilities/resources.ts";

const TEST_NOW_MS = getTestNow();

type RequestHandlerEntry = {
  schema: { shape: { method: { value: string } } };
  handler: (req: unknown) => Promise<unknown>;
};

interface StubServer {
  setRequestHandler: (schema: unknown, handler: (req: unknown) => Promise<unknown>) => void;
  registerCapabilities: (caps: unknown) => void;
  sendResourceUpdated: (params: { uri: string }) => Promise<void>;
  onclose?: () => void;
  handlers: RequestHandlerEntry[];
  notifications: string[];
}

function newStubServer(): StubServer {
  const handlers: RequestHandlerEntry[] = [];
  const notifications: string[] = [];
  return {
    handlers,
    notifications,
    setRequestHandler(schema, handler) {
      handlers.push({ schema: schema as RequestHandlerEntry["schema"], handler });
    },
    registerCapabilities: () => {},
    sendResourceUpdated: async ({ uri }) => {
      notifications.push(uri);
    },
  };
}

function handlerFor(stub: StubServer, method: string): (req: unknown) => Promise<unknown> {
  const entry = stub.handlers.find((h) => h.schema.shape.method.value === method);
  if (!entry) throw new Error(`no handler registered for ${method}`);
  return entry.handler;
}

let testDb: TestDb;
let tenantId = "";
let scopedWorkflowId = "";
let hiddenWorkflowId = "";

beforeAll(async () => {
  testDb = await createTestDb("mcp-resources-portal-scope");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "portal-scope", display_name: "Portal Scope" })
    .returning();
  if (!t) throw new Error("seed tenant");
  tenantId = t.id;

  // Two active workflows in the same tenant — the portal token below
  // is narrowed to one of them.
  for (const slug of ["scoped", "hidden"]) {
    const [wf] = await testDb.db
      .insert(workflows)
      .values({ tenant_id: tenantId, slug: `w178-${slug}`, name: slug, lifecycle: "active" })
      .returning();
    if (!wf) throw new Error(`seed workflow ${slug}`);
    const [v] = await testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenantId,
        workflow_id: wf.id,
        version: 1,
        dag: {
          name: slug,
          slug: `w178-${slug}`,
          steps: [{ id: "noop", kind: "transform", expression: "$" }],
        },
      })
      .returning();
    if (!v) throw new Error(`seed workflow_versions ${slug}`);
    await testDb.db
      .update(workflows)
      .set({ current_version_id: v.id })
      .where(eq(workflows.id, wf.id));
    if (slug === "scoped") scopedWorkflowId = wf.id;
    else hiddenWorkflowId = wf.id;
  }
});

afterAll(async () => {
  await testDb.cleanup();
});

const PORTAL_PRINCIPAL_ID = "00000000-0000-0000-0000-00000000a001";
const METRICS_PRINCIPAL_ID = "00000000-0000-0000-0000-00000000a002";

function portalPrincipal(allowedWorkflows: string[] | "all"): ResolvedPrincipal {
  return {
    id: PORTAL_PRINCIPAL_ID,
    tenant_id: tenantId,
    provider: "portal_token",
    kind: "user",
    roles: ["enduser"],
    allowed_workflows: allowedWorkflows,
  };
}

/**
 * Principal with a built-in role that does NOT include `workflow:read`.
 * Proves the lifecycle dispatcher re-checks RBAC even for non-portal
 * principals, because a tenant can
 * mint a role that omits workflow:read and observe lifecycle timing
 * out of the URI alone.
 */
function nonPortalPrincipalWithoutWorkflowRead(): ResolvedPrincipal {
  return {
    id: METRICS_PRINCIPAL_ID,
    tenant_id: tenantId,
    provider: "api_key",
    kind: "user",
    roles: ["metrics_scraper"],
  };
}

describe("listResources filters by allowed_workflows", () => {
  it("portal token narrowed to one workflow does NOT see the other in listResources", async () => {
    const stub = newStubServer();
    const emitter = new PubSubEmitter();
    registerResourcesCapability({
      server: stub as unknown as Parameters<typeof registerResourcesCapability>[0]["server"],
      db: testDb.db as unknown as Db,
      principal: portalPrincipal([scopedWorkflowId]),
      emitter,
    });

    const listHandler = handlerFor(stub, "resources/list");
    const result = (await listHandler({
      method: "resources/list",
      params: {},
    } as ListResourcesRequest)) as ListResourcesResult;

    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain(`workflow://${scopedWorkflowId}`);
    expect(uris).not.toContain(`workflow://${hiddenWorkflowId}`);
  });

  it("portal token with allowed_workflows='all' sees every active workflow", async () => {
    const stub = newStubServer();
    const emitter = new PubSubEmitter();
    registerResourcesCapability({
      server: stub as unknown as Parameters<typeof registerResourcesCapability>[0]["server"],
      db: testDb.db as unknown as Db,
      principal: portalPrincipal("all"),
      emitter,
    });

    const listHandler = handlerFor(stub, "resources/list");
    const result = (await listHandler({
      method: "resources/list",
      params: {},
    } as ListResourcesRequest)) as ListResourcesResult;

    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain(`workflow://${scopedWorkflowId}`);
    expect(uris).toContain(`workflow://${hiddenWorkflowId}`);
  });
});

describe("lifecycle dispatcher re-checks RBAC", () => {
  it("does NOT forward workflow.lifecycle notifications when allowed_workflows excludes the id", async () => {
    const stub = newStubServer();
    const emitter = new PubSubEmitter();
    registerResourcesCapability({
      server: stub as unknown as Parameters<typeof registerResourcesCapability>[0]["server"],
      db: testDb.db as unknown as Db,
      principal: portalPrincipal([scopedWorkflowId]),
      emitter,
    });

    // Out-of-band subscribe to the hidden workflow's URI (mirrors the
    // attack vector — the client learned the id elsewhere and tried to
    // piggy-back via the subscribe channel).
    const subscribeHandler = handlerFor(stub, "resources/subscribe");
    await subscribeHandler({
      method: "resources/subscribe",
      params: { uri: `workflow://${hiddenWorkflowId}` },
    } as SubscribeRequest);

    await emitter.dispatch({
      id: 1,
      tenant_id: tenantId,
      channel: "workflow.lifecycle",
      type: "workflow.updated",
      payload: { workflow_id: hiddenWorkflowId, slug: "w178-hidden", version: 2 },
      created_at: new Date(TEST_NOW_MS),
    });

    await new Promise((r) => setTimeout(r, 50)); // allow-wall-clock: pub/sub propagation cadence
    expect(stub.notifications).not.toContain(`workflow://${hiddenWorkflowId}`);
  });

  it("DOES forward workflow.lifecycle notifications when allowed_workflows includes the id", async () => {
    const stub = newStubServer();
    const emitter = new PubSubEmitter();
    registerResourcesCapability({
      server: stub as unknown as Parameters<typeof registerResourcesCapability>[0]["server"],
      db: testDb.db as unknown as Db,
      principal: portalPrincipal([scopedWorkflowId]),
      emitter,
    });

    const subscribeHandler = handlerFor(stub, "resources/subscribe");
    await subscribeHandler({
      method: "resources/subscribe",
      params: { uri: `workflow://${scopedWorkflowId}` },
    } as SubscribeRequest);

    await emitter.dispatch({
      id: 2,
      tenant_id: tenantId,
      channel: "workflow.lifecycle",
      type: "workflow.updated",
      payload: { workflow_id: scopedWorkflowId, slug: "w178-scoped", version: 2 },
      created_at: new Date(TEST_NOW_MS),
    });

    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 2_000;
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (stub.notifications.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25)); // allow-wall-clock: pub/sub propagation cadence
    }
    expect(stub.notifications).toContain(`workflow://${scopedWorkflowId}`);
  });
});

describe("RBAC re-check runs for non-portal principals too", () => {
  it("custom-role principal lacking workflow:read does NOT receive lifecycle pings", async () => {
    const stub = newStubServer();
    const emitter = new PubSubEmitter();
    registerResourcesCapability({
      server: stub as unknown as Parameters<typeof registerResourcesCapability>[0]["server"],
      db: testDb.db as unknown as Db,
      // metrics_scraper is a built-in role with `metrics:read` only —
      // explicitly lacks `workflow:read`. The lifecycle dispatcher must
      // still re-check `can()` even though this
      // principal has NO `allowed_workflows` array — otherwise it
      // would observe timing of every workflow state change.
      principal: nonPortalPrincipalWithoutWorkflowRead(),
      emitter,
    });

    const subscribeHandler = handlerFor(stub, "resources/subscribe");
    await subscribeHandler({
      method: "resources/subscribe",
      params: { uri: `workflow://${scopedWorkflowId}` },
    } as SubscribeRequest);

    await emitter.dispatch({
      id: 3,
      tenant_id: tenantId,
      channel: "workflow.lifecycle",
      type: "workflow.updated",
      payload: { workflow_id: scopedWorkflowId, slug: "w178-scoped", version: 3 },
      created_at: new Date(TEST_NOW_MS),
    });

    await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: pub/sub propagation cadence
    expect(stub.notifications).toHaveLength(0);
  });
});
