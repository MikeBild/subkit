import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { tenants } from "../db/schema/identity.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createSeededRandom, FROZEN_NOW } from "../test-helpers/determinism/index.ts";
import { listWorkflowToolSlugs, listWorkflowToolsForTenant } from "./catalog.ts";

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

describe("listWorkflowToolSlugs — the snapshot's tool set is the palette's tool set", () => {
  test("returns exactly the slugs that become wf_ tools, under the same filter, order and cap", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-03-01T00:00:00Z");
    await seedWorkflow({ slug: "palette-recent", last_executed_at: recent });
    await seedWorkflow({ slug: "palette-old", last_executed_at: old });
    await seedWorkflow({ slug: "palette-never", last_executed_at: null });
    await seedWorkflow({ slug: "palette-non-tool", is_tool: false });
    await seedWorkflow({ slug: "palette-draft", has_version: false });
    await seedWorkflow({ slug: "palette-deleted", deleted: true });
    await seedWorkflow({ slug: "palette-foreign", tenant_id: otherTenantId });

    const principal = makePrincipal();
    const slugs = await listWorkflowToolSlugs({ db: tdb.db, principal, limit: 2 });
    const palette = await listWorkflowToolsForTenant({ db: tdb.db, principal, limit: 2 });

    expect([...slugs].sort()).toEqual(palette.map((entry) => entry.slug).sort());
    expect([...slugs].sort()).toEqual(["palette-old", "palette-recent"]);
    for (const hidden of [
      "palette-never",
      "palette-non-tool",
      "palette-draft",
      "palette-deleted",
      "palette-foreign",
    ]) {
      expect(slugs.has(hidden), hidden).toBe(false);
    }
  });

  test("honours the principal's workflow allow-list", async () => {
    const allowed = await seedWorkflow({ slug: "allowlisted" });
    await seedWorkflow({ slug: "not-allowlisted" });
    const slugs = await listWorkflowToolSlugs({
      db: tdb.db,
      principal: makePrincipal({ allowed_workflows: [allowed.id] }),
    });
    expect([...slugs]).toEqual(["allowlisted"]);
  });
});

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

describe("listWorkflowToolsForTenant — 40-row cap", () => {
  test("default limit caps at 40 rows", async () => {
    for (let i = 0; i < 45; i++) {
      await seedWorkflow({ slug: `cap-wf-${i.toString().padStart(3, "0")}` });
    }

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

describe("listWorkflowToolsForTenant — palette_truncated cap", () => {
  test("limit is a hard cap: exactly `limit` descriptors are returned when more rows exist", async () => {
    const limit = 3;
    for (let i = 0; i < limit + 2; i++) {
      await seedWorkflow({ slug: `cap-small-${i}` });
    }

    const results = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal(),
      limit,
    });

    expect(results.length).toBeLessThanOrEqual(limit);

    const slugs = results.map((r) => r.slug);
    for (const slug of slugs) {
      expect(slug).toMatch(/^cap-small-\d+$/);
    }
  });

  test("workflows beyond the cap are absent from the returned descriptors", async () => {
    const limit = 2;
    const recent = new Date("2026-05-01T00:00:00Z");
    const older = new Date("2026-01-01T00:00:00Z");

    const { id: id0 } = await seedWorkflow({ slug: "cap-lru-0", last_executed_at: recent });
    const { id: id1 } = await seedWorkflow({ slug: "cap-lru-1", last_executed_at: older });
    const { id: id2 } = await seedWorkflow({ slug: "cap-lru-2", last_executed_at: null });

    const results = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal(),
      limit,
    });

    const ids = results.map((r) => r.workflow_id);
    expect(ids).toContain(id0);
    expect(ids).toContain(id1);
    expect(ids).not.toContain(id2);
  });
});

describe("listWorkflowToolsForTenant — tenant isolation", () => {
  test("principal from other tenant sees no workflows", async () => {
    await seedWorkflow({ slug: "tenant-own-wf" });

    const results = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal({ tenant_id: otherTenantId }),
    });
    expect(results.length).toBe(0);
  });
});

describe("listWorkflowToolsForTenant — descriptor shape", () => {
  test("returned descriptors carry required fields", async () => {
    await seedWorkflow({ slug: "shape-check", name: "Shape Check" });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const item = results[0];
    expect(item).toBeDefined();
    expect(typeof item!.workflow_id).toBe("string");
    expect(typeof item!.slug).toBe("string");
    expect(typeof item!.name).toBe("string");
    expect(item!.description).toBeNull();
    expect(item!.category).toBe("other");
    expect(typeof item!.inputSchema).toBe("object");
    expect(item!.inputSchema.type).toBe("object");
  });

  test("a description only the definition carries is not the workflow's description", async () => {
    await seedWorkflow({
      slug: "no-desc-wf",
      name: "My Workflow Name",
      dag: {
        name: "My Workflow Name",
        slug: "no-desc-wf",
        description: "Text that only lived in an old definition.",
        steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
      },
    });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const item = results.find((r) => r.slug === "no-desc-wf");
    expect(item?.description).toBeNull();
  });
});

describe("listWorkflowToolsForTenant — inputSchema property descriptions", () => {
  test("declared input_schema properties with description flow into inputSchema", async () => {
    await seedWorkflow({
      slug: "schema-desc-wf",
      name: "Schema Desc WF",
      dag: {
        name: "Schema Desc WF",
        slug: "schema-desc-wf",
        input_schema: {
          type: "object",
          properties: {
            startDate: {
              type: "string",
              description: "ISO 8601 start date for the report range",
            },
            limit: {
              type: "integer",
              description: "Maximum number of rows to return",
            },
          },
          required: ["startDate"],
        },
        steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
      },
    });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const item = results.find((r) => r.slug === "schema-desc-wf");
    expect(item).toBeDefined();

    const props = item?.inputSchema.properties as Record<string, unknown> | undefined;
    expect(props).toBeDefined();
    expect((props!.startDate as Record<string, unknown>)?.description).toBe(
      "ISO 8601 start date for the report range",
    );
    expect((props!.limit as Record<string, unknown>)?.description).toBe(
      "Maximum number of rows to return",
    );
  });

  test("inputSchema without per-property description is still returned (empty string not injected)", async () => {
    await seedWorkflow({
      slug: "schema-no-desc-wf",
      name: "Schema No Desc WF",
      dag: {
        name: "Schema No Desc WF",
        slug: "schema-no-desc-wf",
        input_schema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
      },
    });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const item = results.find((r) => r.slug === "schema-no-desc-wf");
    expect(item).toBeDefined();
    const props = item?.inputSchema.properties as Record<string, unknown> | undefined;
    expect(props).toBeDefined();
    expect((props!.id as Record<string, unknown>)?.description).toBeUndefined();
  });
});

describe("listWorkflowToolsForTenant — outputSchema", () => {
  test("declared output_schema with type:object is surfaced as outputSchema", async () => {
    await seedWorkflow({
      slug: "output-schema-wf",
      name: "Output Schema WF",
      dag: {
        name: "Output Schema WF",
        slug: "output-schema-wf",
        output_schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string", description: "User display name" },
          },
        },
        steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
      },
    });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const item = results.find((r) => r.slug === "output-schema-wf");
    expect(item).toBeDefined();

    expect(item?.outputSchema).toBeDefined();
    expect(item?.outputSchema?.type).toBe("object");
    const outProps = item?.outputSchema?.properties as Record<string, unknown> | undefined;
    expect(outProps?.id).toBeDefined();
    expect((outProps!.name as Record<string, unknown>)?.description).toBe("User display name");
  });

  test("workflow without output_schema has no outputSchema on descriptor", async () => {
    await seedWorkflow({
      slug: "no-output-schema-wf",
      name: "No Output Schema WF",
      dag: {
        name: "No Output Schema WF",
        slug: "no-output-schema-wf",
        steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
      },
    });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const item = results.find((r) => r.slug === "no-output-schema-wf");
    expect(item).toBeDefined();
    expect(item?.outputSchema).toBeUndefined();
  });

  test("output_schema with non-object type is rejected (no outputSchema on descriptor)", async () => {
    await seedWorkflow({
      slug: "array-output-schema-wf",
      name: "Array Output Schema WF",
      dag: {
        name: "Array Output Schema WF",
        slug: "array-output-schema-wf",
        output_schema: {
          type: "array",
          items: { type: "string" },
        },
        steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
      },
    });
    const results = await listWorkflowToolsForTenant({ db: tdb.db, principal: makePrincipal() });
    const item = results.find((r) => r.slug === "array-output-schema-wf");
    expect(item).toBeDefined();
    expect(item?.outputSchema).toBeUndefined();
  });
});

describe("listWorkflowToolsForTenant — dispatchable aliases only", () => {
  const productBoundDag = {
    name: "Product round",
    slug: "product-round",
    product_id: "tekit",
    required_caller_kind: "user",
    execution_privacy: "sensitive",
    input_schema: {
      type: "object",
      properties: { purpose: { type: "string" } },
      required: ["purpose"],
      additionalProperties: false,
      oneOf: [
        { properties: { purpose: { const: "round" } } },
        { properties: { purpose: { const: "classify" } } },
      ],
    },
    steps: [{ id: "s1", kind: "request", url: "https://example.test/round" }],
  };

  test("a cockpit user on chat sees only workflows that chat can run", async () => {
    await seedWorkflow({ slug: "product-round", dag: productBoundDag });
    await seedWorkflow({ slug: "plain-tool" });
    const principal = makePrincipal();
    const palette = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal,
      request_source: "chat",
    });
    const slugs = await listWorkflowToolSlugs({ db: tdb.db, principal, request_source: "chat" });
    expect(palette.map((entry) => entry.slug)).toEqual(["plain-tool"]);
    expect([...slugs]).toEqual(["plain-tool"]);
  });

  test("a sensitive workflow keeps its alias on mcp and loses it on chat", async () => {
    await seedWorkflow({
      slug: "sensitive-tool",
      dag: {
        name: "Sensitive tool",
        slug: "sensitive-tool",
        execution_privacy: "sensitive",
        steps: [{ id: "s1", kind: "request", url: "https://example.test/sensitive" }],
      },
    });
    await seedWorkflow({ slug: "plain-tool" });
    const principal = makePrincipal();
    const onMcp = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal,
      request_source: "mcp",
    });
    const onChat = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal,
      request_source: "chat",
    });
    expect(onMcp.map((entry) => entry.slug)).toEqual(["plain-tool", "sensitive-tool"]);
    expect(onChat.map((entry) => entry.slug)).toEqual(["plain-tool"]);
  });

  test("a product-bound workflow stays out of mcp for a caller without that product", async () => {
    await seedWorkflow({ slug: "product-round", dag: productBoundDag });
    await seedWorkflow({ slug: "plain-tool" });
    const onMcp = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal(),
      request_source: "mcp",
    });
    expect(onMcp.map((entry) => entry.slug)).toEqual(["plain-tool"]);
  });

  test("non-dispatchable aliases do not consume palette slots", async () => {
    await seedWorkflow({
      slug: "product-round",
      dag: productBoundDag,
      last_executed_at: new Date("2026-03-01T00:00:00Z"),
    });
    await seedWorkflow({ slug: "plain-tool", last_executed_at: new Date("2026-01-01T00:00:00Z") });
    const palette = await listWorkflowToolsForTenant({
      db: tdb.db,
      principal: makePrincipal(),
      request_source: "chat",
      limit: 1,
    });
    expect(palette.map((entry) => entry.slug)).toEqual(["plain-tool"]);
  });
});
