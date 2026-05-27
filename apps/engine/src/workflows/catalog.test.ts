// Integration tests for listWorkflowToolsForTenant.
// Uses testcontainers postgres (createTestDb) — no mocks of the DB.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { tenants } from "../db/schema/identity.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createSeededRandom, FROZEN_NOW } from "../test-helpers/determinism/index.ts";
import { listWorkflowToolsForTenant } from "./catalog.ts";

const seedRand = createSeededRandom(0xc47a106);

let tdb: TestDb;
let tenantId: string;
let otherTenantId: string;

function makePrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: "u-test",
    tenant_id: tenantId,
    roles: ["admin"],
    ...overrides,
  };
}

beforeAll(async () => {
  tdb = await createTestDb("workflows-catalog");

  const [t1] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-catalog-1", display_name: "Catalog T1" })
    .returning();
  const [t2] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-catalog-2", display_name: "Catalog T2" })
    .returning();
  if (!t1 || !t2) throw new Error("tenant seed failed");
  tenantId = t1.id;
  otherTenantId = t2.id;
});

afterAll(async () => {
  await tdb.cleanup();
});

beforeEach(async () => {
  await tdb.db.delete(workflowVersions);
  await tdb.db.delete(workflows);
});

interface SeedOpts {
  slug?: string;
  name?: string;
  tenant_id?: string;
  is_tool?: boolean;
  deleted?: boolean;
  last_executed_at?: Date | null;
  has_version?: boolean;
  dag?: Record<string, unknown>;
}

async function seedWorkflow(
  opts: SeedOpts = {},
): Promise<{ id: string; version_id: string | null }> {
  const tid = opts.tenant_id ?? tenantId;
  const slug = opts.slug ?? `wf-${seedRand.int(0, 0xffffff).toString(36).padStart(6, "0")}`;
  const name = opts.name ?? "Test Workflow";
  const hasVersion = opts.has_version !== false;

  const [wf] = await tdb.db
    .insert(workflows)
    .values({
      tenant_id: tid,
      slug,
      name,
      lifecycle: "active",
      is_tool: opts.is_tool ?? true,
      ...(opts.deleted ? { deleted_at: new Date(FROZEN_NOW) } : {}),
      ...(opts.last_executed_at !== undefined ? { last_executed_at: opts.last_executed_at } : {}),
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");

  if (!hasVersion) return { id: wf.id, version_id: null };

  const dag = opts.dag ?? { name, slug, steps: [] };
  const [v] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tid,
      workflow_id: wf.id,
      version: 1,
      dag,
    })
    .returning();
  if (!v) throw new Error("seed workflow version failed");

  await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));

  return { id: wf.id, version_id: v.id };
}

// ---------------------------------------------------------------------------
// is_tool filter
// ---------------------------------------------------------------------------

describe("listWorkflowToolsForTenant — is_tool filter", () => {
  test("workflows with is_tool=false are excluded", async () => {
    await seedWorkflow({ slug: "visible-tool", is_tool: true });
    await seedWorkflow({ slug: "hidden-non-tool", is_tool: false });

    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain("visible-tool");
    expect(slugs).not.toContain("hidden-non-tool");
  });

  test("soft-deleted workflows are excluded regardless of is_tool", async () => {
    await seedWorkflow({ slug: "deleted-tool", is_tool: true, deleted: true });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    expect(results.map((r) => r.slug)).not.toContain("deleted-tool");
  });

  test("draft workflows (no current_version_id) are excluded", async () => {
    await seedWorkflow({ slug: "draft-wf", has_version: false });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    expect(results.map((r) => r.slug)).not.toContain("draft-wf");
  });
});

// ---------------------------------------------------------------------------
// Ordering: last_executed_at DESC NULLS LAST
// ---------------------------------------------------------------------------

describe("listWorkflowToolsForTenant — ordering", () => {
  test("more recently executed workflows appear first", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-05-01T00:00:00Z");

    await seedWorkflow({ slug: "older", last_executed_at: old });
    await seedWorkflow({ slug: "newer", last_executed_at: recent });

    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const slugs = results.map((r) => r.slug);
    expect(slugs.indexOf("newer")).toBeLessThan(slugs.indexOf("older"));
  });

  test("never-executed workflows (null last_executed_at) appear after executed ones", async () => {
    await seedWorkflow({ slug: "executed", last_executed_at: new Date("2026-01-01T00:00:00Z") });
    await seedWorkflow({ slug: "never-run", last_executed_at: null });

    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const slugs = results.map((r) => r.slug);
    expect(slugs.indexOf("executed")).toBeLessThan(slugs.indexOf("never-run"));
  });
});

// ---------------------------------------------------------------------------
// allowed_workflows allow-list
// ---------------------------------------------------------------------------

describe("listWorkflowToolsForTenant — allowed_workflows", () => {
  test("principal with allowed_workflows='all' sees all workflows", async () => {
    const { id: id1 } = await seedWorkflow({ slug: "wf-allow-1" });
    const { id: id2 } = await seedWorkflow({ slug: "wf-allow-2" });
    void id2;

    const results = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal({ allowed_workflows: "all" }),
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.find((r) => r.workflow_id === id1)).toBeDefined();
  });

  test("principal with allowed_workflows array only sees allowed ids", async () => {
    const { id: id1 } = await seedWorkflow({ slug: "allowed-wf" });
    const { id: id2 } = await seedWorkflow({ slug: "blocked-wf" });

    const results = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal({ allowed_workflows: [id1] }),
    });
    expect(results.find((r) => r.workflow_id === id1)).toBeDefined();
    expect(results.find((r) => r.workflow_id === id2)).toBeUndefined();
  });

  test("principal with empty allowed_workflows array sees nothing", async () => {
    await seedWorkflow({ slug: "blocked-all" });
    const results = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal({ allowed_workflows: [] }),
    });
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 40-row cap
// ---------------------------------------------------------------------------

describe("listWorkflowToolsForTenant — 40-row cap", () => {
  test("default limit caps at 40 rows", async () => {
    // Seed 45 workflows
    const seeds: Promise<unknown>[] = [];
    for (let i = 0; i < 45; i++) {
      seeds.push(seedWorkflow({ slug: `cap-wf-${i.toString().padStart(3, "0")}` }));
    }
    await Promise.all(seeds);

    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    expect(results.length).toBeLessThanOrEqual(40);
  });

  test("explicit limit parameter is respected", async () => {
    await seedWorkflow({ slug: "lim-a" });
    await seedWorkflow({ slug: "lim-b" });
    await seedWorkflow({ slug: "lim-c" });

    const results = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal(),
      limit: 2,
    });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Principal mismatch — tenant isolation
// ---------------------------------------------------------------------------

describe("listWorkflowToolsForTenant — tenant isolation", () => {
  test("principal from other tenant sees no workflows", async () => {
    // Seed a workflow in the main tenant
    await seedWorkflow({ slug: "tenant-own-wf" });

    // Query with a principal from the other tenant
    const results = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal({ tenant_id: otherTenantId }),
    });
    // Other tenant has no workflows — should be empty
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Descriptor shape
// ---------------------------------------------------------------------------

describe("listWorkflowToolsForTenant — descriptor shape", () => {
  test("returned descriptors carry required fields", async () => {
    await seedWorkflow({ slug: "shape-check", name: "Shape Check" });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const item = results[0];
    expect(item).toBeDefined();
    expect(typeof item!.workflow_id).toBe("string");
    expect(typeof item!.slug).toBe("string");
    expect(typeof item!.name).toBe("string");
    expect(typeof item!.description).toBe("string");
    expect(typeof item!.inputSchema).toBe("object");
    expect(item!.inputSchema.type).toBe("object");
  });

  test("descriptor description falls back to workflow name when dag has no description field", async () => {
    await seedWorkflow({
      slug: "no-desc-wf",
      name: "My Workflow Name",
      // dag without description — catalog must use name as fallback
      dag: {
        name: "My Workflow Name",
        slug: "no-desc-wf",
        steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
      },
    });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const item = results.find((r) => r.slug === "no-desc-wf");
    expect(typeof item?.description).toBe("string");
    expect(item?.description).toBe("My Workflow Name");
  });
});
