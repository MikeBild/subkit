import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tenants } from "../db/schema/identity.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/index.ts";
import { looksLikeUuid, resolveWorkflowByIdOrSlug } from "./lookup.ts";

let tdb: TestDb;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  tdb = await createTestDb("workflows-lookup");

  const [t1] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-lookup-1", display_name: "Tenant 1" })
    .returning();
  const [t2] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-lookup-2", display_name: "Tenant 2" })
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

async function seedWorkflow(
  opts: {
    tenant_id?: string;
    slug?: string;
    name?: string;
    deleted?: boolean;
    is_tool?: boolean;
  } = {},
): Promise<{ id: string; version_id: string }> {
  const tid = opts.tenant_id ?? tenantId;
  const slug = opts.slug ?? "test-workflow";
  const name = opts.name ?? "Test Workflow";

  const [wf] = await tdb.db
    .insert(workflows)
    .values({
      tenant_id: tid,
      slug,
      name,
      lifecycle: "active",
      is_tool: opts.is_tool ?? true,
      ...(opts.deleted ? { deleted_at: new Date(FROZEN_NOW) } : {}),
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");

  const [v] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tid,
      workflow_id: wf.id,
      version: 1,
      dag: { name, slug, steps: [] },
    })
    .returning();
  if (!v) throw new Error("seed workflow version failed");

  const { eq } = await import("drizzle-orm");
  await tdb.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));

  return { id: wf.id, version_id: v.id };
}

describe("looksLikeUuid", () => {
  test("recognises a v4 UUID", () => {
    expect(looksLikeUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("recognises a v7 UUID (time-ordered)", () => {
    expect(looksLikeUuid("01927a2b-e123-78cd-9abc-123456789abc")).toBe(true);
  });

  test("rejects a slug", () => {
    expect(looksLikeUuid("my-workflow")).toBe(false);
  });

  test("rejects an empty string", () => {
    expect(looksLikeUuid("")).toBe(false);
  });

  test("rejects a UUID with wrong segment lengths", () => {
    expect(looksLikeUuid("550e8400-e29b-41d4-a716-44665544000")).toBe(false);
  });
});

describe("resolveWorkflowByIdOrSlug — uuid path", () => {
  test("returns the row when looking up by UUID", async () => {
    const { id } = await seedWorkflow({ slug: "uuid-lookup" });
    const result = await resolveWorkflowByIdOrSlug(tdb.db, tenantId, id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(id);
    expect(result?.slug).toBe("uuid-lookup");
  });

  test("returns null for a non-existent UUID", async () => {
    const result = await resolveWorkflowByIdOrSlug(
      tdb.db,
      tenantId,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });
});

describe("resolveWorkflowByIdOrSlug — slug path", () => {
  test("returns the row when looking up by slug", async () => {
    const { id } = await seedWorkflow({ slug: "my-slug" });
    const result = await resolveWorkflowByIdOrSlug(tdb.db, tenantId, "my-slug");
    expect(result).not.toBeNull();
    expect(result?.id).toBe(id);
    expect(result?.slug).toBe("my-slug");
  });

  test("returns null for an unknown slug", async () => {
    const result = await resolveWorkflowByIdOrSlug(tdb.db, tenantId, "does-not-exist");
    expect(result).toBeNull();
  });

  test("returns is_tool field correctly", async () => {
    await seedWorkflow({ slug: "not-a-tool", is_tool: false });
    const result = await resolveWorkflowByIdOrSlug(tdb.db, tenantId, "not-a-tool");
    expect(result?.is_tool).toBe(false);
  });
});

describe("resolveWorkflowByIdOrSlug — soft-deleted excluded", () => {
  test("slug lookup returns null for a soft-deleted row", async () => {
    await seedWorkflow({ slug: "deleted-wf", deleted: true });
    const result = await resolveWorkflowByIdOrSlug(tdb.db, tenantId, "deleted-wf");
    expect(result).toBeNull();
  });

  test("uuid lookup returns null for a soft-deleted row", async () => {
    const { id } = await seedWorkflow({ slug: "deleted-uuid-wf", deleted: true });
    const result = await resolveWorkflowByIdOrSlug(tdb.db, tenantId, id);
    expect(result).toBeNull();
  });
});

describe("resolveWorkflowByIdOrSlug — tenant isolation", () => {
  test("workflow in other tenant is invisible to the requesting tenant (slug)", async () => {
    await seedWorkflow({ tenant_id: otherTenantId, slug: "other-tenant-wf" });
    const result = await resolveWorkflowByIdOrSlug(tdb.db, tenantId, "other-tenant-wf");
    expect(result).toBeNull();
  });

  test("workflow in other tenant is invisible to the requesting tenant (uuid)", async () => {
    const { id } = await seedWorkflow({ tenant_id: otherTenantId, slug: "other-uuid-wf" });
    const result = await resolveWorkflowByIdOrSlug(tdb.db, tenantId, id);
    expect(result).toBeNull();
  });

  test("same-name workflows in different tenants don't collide", async () => {
    await seedWorkflow({ tenant_id: tenantId, slug: "shared-slug" });
    await seedWorkflow({ tenant_id: otherTenantId, slug: "shared-slug" });

    const r1 = await resolveWorkflowByIdOrSlug(tdb.db, tenantId, "shared-slug");
    const r2 = await resolveWorkflowByIdOrSlug(tdb.db, otherTenantId, "shared-slug");
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1?.id).not.toBe(r2?.id);
  });
});
