import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createEmptyDraftDocument } from "../conversations/authoring-state/index.ts";
import type { ToolContext } from "../conversations/tools/index.ts";
import { connectors, conversations, tenants, workflows } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { EngineClient } from "../engine-client/index.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";
import { FROZEN_NOW } from "./determinism/clock.ts";
import { adminPrincipal } from "./principals.ts";
import {
  adminHeaders,
  makeToolCtx,
  seedConnector,
  seedConversation,
  seedTenant,
  seedTimestamp,
  seedUuid,
  seedWorkflow,
} from "./seed.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

describe("seed id and timestamp defaults", () => {
  test("seedUuid yields a v4-shaped uuid per entity", () => {
    expect(seedUuid("tenant", 1)).toBe("5eed0001-0000-4000-8000-000000000001");
    expect(seedUuid("workflow", 255)).toBe("5eed0002-0000-4000-8000-0000000000ff");
    expect(seedUuid("connector", 1)).toMatch(UUID_RE);
  });

  test("seedTimestamp counts seconds from FROZEN_NOW", () => {
    expect(seedTimestamp(0).getTime()).toBe(FROZEN_NOW);
    expect(seedTimestamp(3).getTime()).toBe(FROZEN_NOW + 3000);
  });
});

describe("adminHeaders", () => {
  test("builds bearer and json headers and merges extras", () => {
    expect(adminHeaders("sk_test")).toEqual({
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    });
    expect(adminHeaders("sk_test", { "x-request-id": "r1" })).toEqual({
      authorization: "Bearer sk_test",
      "content-type": "application/json",
      "x-request-id": "r1",
    });
  });
});

const skip = process.env.SKIP_DOCKER === "1" || process.env.REQUIRES_PG === "0";

describe.skipIf(skip)("seeders against a migrated database", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb("seed_helpers");
  });

  afterAll(async () => {
    await testDb?.cleanup();
  });

  test("seedTenant inserts defaults and distinct rows", async () => {
    const a = await seedTenant(testDb.db);
    const b = await seedTenant(testDb.db);
    expect(a.id).toMatch(UUID_RE);
    expect(a.id).not.toBe(b.id);
    expect(a.slug).not.toBe(b.slug);
    expect(a.origin).toBe("self_hosted");
    expect(a.status).toBe("active");
    expect(a.created_at.getTime()).toBeGreaterThanOrEqual(FROZEN_NOW);
    const [stored] = await testDb.db.select().from(tenants).where(eq(tenants.id, a.id));
    expect(stored?.slug).toBe(a.slug);
  });

  test("seedTenant respects overrides", async () => {
    const at = seedTimestamp(9000);
    const row = await seedTenant(testDb.db, {
      id: "00000000-0000-4000-8000-00000000a001",
      slug: "acme",
      display_name: "Acme",
      timezone: "Europe/Berlin",
      created_at: at,
    });
    expect(row.id).toBe("00000000-0000-4000-8000-00000000a001");
    expect(row.slug).toBe("acme");
    expect(row.display_name).toBe("Acme");
    expect(row.timezone).toBe("Europe/Berlin");
    expect(row.created_at.getTime()).toBe(at.getTime());
  });

  test("seedWorkflow inserts workflow and version and links current_version_id", async () => {
    const tenant = await seedTenant(testDb.db);
    const { workflow, version } = await seedWorkflow(testDb.db, { tenant_id: tenant.id });
    expect(workflow.tenant_id).toBe(tenant.id);
    expect(workflow.lifecycle).toBe("active");
    expect(workflow.current_version_id).toBe(version.id);
    expect(version.workflow_id).toBe(workflow.id);
    expect(version.tenant_id).toBe(tenant.id);
    expect(version.version).toBe(1);
    const parsed = WorkflowDefSchema.parse(version.dag);
    expect(parsed.slug).toBe(workflow.slug);
    expect(parsed.name).toBe(workflow.name);
    const [stored] = await testDb.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant.id), eq(workflows.id, workflow.id)));
    expect(stored?.current_version_id).toBe(version.id);
    const second = await seedWorkflow(testDb.db, { tenant_id: tenant.id });
    expect(second.workflow.slug).not.toBe(workflow.slug);
  });

  test("seedWorkflow takes slug and name from def and respects overrides", async () => {
    const tenant = await seedTenant(testDb.db);
    const def = WorkflowDefSchema.parse({
      name: "Fetch users",
      slug: "fetch-users",
      steps: [{ id: "shape", kind: "transform", expression: "return 2;" }],
    });
    const { workflow, version } = await seedWorkflow(testDb.db, {
      tenant_id: tenant.id,
      def,
      lifecycle: "draft",
      category: "crm",
      is_tool: false,
      version: { version: 3, note: "seeded" },
    });
    expect(workflow.slug).toBe("fetch-users");
    expect(workflow.name).toBe("Fetch users");
    expect(workflow.lifecycle).toBe("draft");
    expect(workflow.category).toBe("crm");
    expect(workflow.is_tool).toBe(false);
    expect(version.version).toBe(3);
    expect(version.note).toBe("seeded");
    expect(version.dag).toEqual(def);
  });

  test("seedWorkflow stores a raw dag unchanged", async () => {
    const tenant = await seedTenant(testDb.db);
    const dag = { name: "Raw", slug: "raw-dag", steps: [{ id: "x", kind: "unregistered-kind" }] };
    const { workflow, version } = await seedWorkflow(testDb.db, { tenant_id: tenant.id, dag });
    expect(workflow.slug).toBe("raw-dag");
    expect(workflow.name).toBe("Raw");
    expect(version.dag).toEqual(dag);
  });

  test("seedConnector inserts defaults and respects overrides", async () => {
    const tenant = await seedTenant(testDb.db);
    const a = await seedConnector(testDb.db, { tenant_id: tenant.id });
    const b = await seedConnector(testDb.db, { tenant_id: tenant.id });
    expect(a.slug).not.toBe(b.slug);
    expect(a.driver).toBe("http");
    expect(a.environment).toBe("dev");
    expect(a.auth_type).toBe("none");
    expect(a.base_url).toBe("https://example.test");
    expect(a.enabled).toBe(true);
    const custom = await seedConnector(testDb.db, {
      tenant_id: tenant.id,
      slug: "stripe",
      environment: "prod",
      auth_type: "bearer",
      base_url: "https://api.stripe.test",
      needs_reauth: true,
    });
    expect(custom.slug).toBe("stripe");
    expect(custom.environment).toBe("prod");
    expect(custom.auth_type).toBe("bearer");
    expect(custom.needs_reauth).toBe(true);
    const [stored] = await testDb.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant.id), eq(connectors.id, custom.id)));
    expect(stored?.base_url).toBe("https://api.stripe.test");
  });

  test("seedConversation inserts defaults and respects overrides", async () => {
    const tenant = await seedTenant(testDb.db);
    const a = await seedConversation(testDb.db, { tenant_id: tenant.id });
    expect(a.status).toBe("active");
    expect(a.tenant_id).toBe(tenant.id);
    expect(a.draft).toEqual(createEmptyDraftDocument());
    const { workflow } = await seedWorkflow(testDb.db, { tenant_id: tenant.id });
    const b = await seedConversation(testDb.db, {
      tenant_id: tenant.id,
      status: "awaiting_input",
      title: "Billing",
      surface: "web",
      target_workflow_id: workflow.id,
    });
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe("awaiting_input");
    expect(b.title).toBe("Billing");
    expect(b.target_workflow_id).toBe(workflow.id);
    const [stored] = await testDb.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant.id), eq(conversations.id, b.id)));
    expect(stored?.surface).toBe("web");
  });

  test("makeToolCtx builds a ToolContext with a round-tripping draft", async () => {
    const tenant = await seedTenant(testDb.db);
    const ctx: ToolContext = makeToolCtx({ db: testDb.db, tenant_id: tenant.id });
    expect(ctx.tenant_id).toBe(tenant.id);
    expect(ctx.conversation_id).toMatch(UUID_RE);
    expect(ctx.actor_id).toBeNull();
    expect(ctx.principal).toBeUndefined();
    expect(ctx.engineClient).toBeInstanceOf(EngineClient);
    expect(ctx.getDraft()).toEqual(createEmptyDraftDocument());
    const next = { ...createEmptyDraftDocument(), connector: null, latest_preview: null };
    await ctx.setDraft(next);
    expect(ctx.getDraft()).toBe(next);
  });

  test("makeToolCtx respects principal, draft and overrides", async () => {
    const tenant = await seedTenant(testDb.db);
    const conversation = await seedConversation(testDb.db, { tenant_id: tenant.id });
    const principal = adminPrincipal(tenant.id);
    const draft = createEmptyDraftDocument("workflow_authoring");
    const ctx = makeToolCtx({
      db: testDb.db,
      tenant_id: tenant.id,
      conversation_id: conversation.id,
      actor_id: principal.id,
      principal,
      draft,
      surface: "web",
    });
    expect(ctx.conversation_id).toBe(conversation.id);
    expect(ctx.actor_id).toBe(principal.id);
    expect(ctx.principal).toBe(principal);
    expect(ctx.surface).toBe("web");
    expect(ctx.draft).toBe(draft);
    const replaced = createEmptyDraftDocument();
    await ctx.setDraft(replaced);
    expect(ctx.draft).toBe(replaced);
  });
});
