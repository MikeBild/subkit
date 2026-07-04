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
  ReadResourceRequest,
  SubscribeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/identity.ts";
import {
  files,
  knowledgeSources,
  skillCandidates,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
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
  sendResourceListChanged: () => Promise<void>;
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
    sendResourceListChanged: async () => {},
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
let knowledgeSourceId = "";
let skillCandidateId = "";
let fileId = "";

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

  const [knowledge] = await testDb.db
    .insert(knowledgeSources)
    .values({
      tenant_id: tenantId,
      name: "RBAC hidden knowledge",
      slug: "rbac-hidden-knowledge",
      source_type: "inline",
      source_uri: "inline://rbac-hidden-knowledge",
      version: "v1",
      status: "active",
    })
    .returning({ id: knowledgeSources.id });
  if (!knowledge) throw new Error("seed knowledge source");
  knowledgeSourceId = knowledge.id;

  const [skillCandidate] = await testDb.db
    .insert(skillCandidates)
    .values({
      tenant_id: tenantId,
      scope: "global",
      pattern_kind: "success_pattern",
      title: "RBAC hidden skill candidate",
      body: "Do not leak this candidate through MCP resources/list.",
      examples: [],
      evidence: {},
      confidence: "medium",
      status: "proposed",
      fingerprint: "rbac-hidden-skill-candidate",
    })
    .returning({ id: skillCandidates.id });
  if (!skillCandidate) throw new Error("seed skill candidate");
  skillCandidateId = skillCandidate.id;

  const [file] = await testDb.db
    .insert(files)
    .values({
      tenant_id: tenantId,
      status: "ready",
      filename: "rbac-hidden.txt",
      content_type: "text/plain",
      size_bytes: 12,
      storage_uri: "local://rbac-hidden.txt",
      sha256: "rbac-hidden-file",
    })
    .returning({ id: files.id });
  if (!file) throw new Error("seed file");
  fileId = file.id;
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

describe("list/read RBAC parity", () => {
  it("hides and rejects knowledge, skill candidates, files, and operator digest without read permissions", async () => {
    const stub = newStubServer();
    const emitter = new PubSubEmitter();
    registerResourcesCapability({
      server: stub as unknown as Parameters<typeof registerResourcesCapability>[0]["server"],
      db: testDb.db as unknown as Db,
      principal: nonPortalPrincipalWithoutWorkflowRead(),
      emitter,
    });

    const listHandler = handlerFor(stub, "resources/list");
    const list = (await listHandler({
      method: "resources/list",
      params: {},
    } as ListResourcesRequest)) as ListResourcesResult;
    const uris = list.resources.map((r) => r.uri);

    expect(uris).not.toContain(`knowledge://${knowledgeSourceId}`);
    expect(uris).not.toContain(`skill-candidate://${skillCandidateId}`);
    expect(uris).not.toContain(`file://${fileId}`);
    expect(uris).not.toContain("subkit://operator/health-digest");

    const readHandler = handlerFor(stub, "resources/read");
    for (const uri of [
      `knowledge://${knowledgeSourceId}`,
      `skill-candidate://${skillCandidateId}`,
      `file://${fileId}`,
      "subkit://operator/health-digest",
    ]) {
      await expect(
        readHandler({ method: "resources/read", params: { uri } } as ReadResourceRequest),
      ).rejects.toThrow();
    }
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

  it("does NOT forward workflow.lifecycle notifications after permission is revoked post-subscribe", async () => {
    const stub = newStubServer();
    const emitter = new PubSubEmitter();
    const principal: ResolvedPrincipal = {
      id: "00000000-0000-0000-0000-00000000a003",
      tenant_id: tenantId,
      provider: "api_key",
      kind: "user",
      roles: ["admin"],
    };
    registerResourcesCapability({
      server: stub as unknown as Parameters<typeof registerResourcesCapability>[0]["server"],
      db: testDb.db as unknown as Db,
      principal,
      emitter,
    });

    const subscribeHandler = handlerFor(stub, "resources/subscribe");
    await subscribeHandler({
      method: "resources/subscribe",
      params: { uri: `workflow://${scopedWorkflowId}` },
    } as SubscribeRequest);

    principal.roles = ["metrics_scraper"];
    await emitter.dispatch({
      id: 4,
      tenant_id: tenantId,
      channel: "workflow.lifecycle",
      type: "workflow.updated",
      payload: { workflow_id: scopedWorkflowId, slug: "w178-scoped", version: 4 },
      created_at: new Date(TEST_NOW_MS),
    });

    await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: pub/sub propagation cadence
    expect(stub.notifications).toHaveLength(0);
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
