import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { tenants, workflows, workflowVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { resolveDefinition } from "./resolve-definition.ts";

let testDb: TestDb;
let tenantId = "";
let workflowAId = "";
let versionAId = "";
let versionBId = "";

beforeAll(async () => {
  testDb = await createTestDb("resolve-definition");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "resolve-def", display_name: "Resolve Def" })
    .returning();
  tenantId = t!.id;

  const [a] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "wf-a", name: "Workflow A", lifecycle: "active" })
    .returning();
  const [b] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "wf-b", name: "Workflow B", lifecycle: "active" })
    .returning();
  workflowAId = a!.id;

  const stepA = [{ id: "noop", kind: "transform", expression: "$input" }];
  const [va] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: a!.id,
      version: 1,
      dag: { name: "a", steps: stepA },
    })
    .returning();
  const [vb] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: b!.id,
      version: 1,
      dag: { name: "b", steps: stepA },
    })
    .returning();
  versionAId = va!.id;
  versionBId = vb!.id;

  await testDb.db
    .update(workflows)
    .set({ current_version_id: va!.id })
    .where(eq(workflows.id, a!.id));
});

afterAll(async () => {
  if (testDb) await testDb.cleanup();
});

describe("resolveDefinition — saved source", () => {
  test("rejects a version_id belonging to a different workflow (injection)", async () => {
    await expect(
      resolveDefinition(testDb.db, tenantId, {
        kind: "saved",
        workflow_id: workflowAId,
        version_id: versionBId,
      }),
    ).rejects.toThrow(/version not found/);
  });

  test("resolves a version_id that belongs to the workflow", async () => {
    const resolved = await resolveDefinition(testDb.db, tenantId, {
      kind: "saved",
      workflow_id: workflowAId,
      version_id: versionAId,
    });
    expect(resolved.workflow_id).toBe(workflowAId);
    expect(resolved.workflow_version_id).toBe(versionAId);
    expect(resolved.def.name).toBe("a");
  });

  test("falls back to the workflow's current version when version_id is omitted", async () => {
    const resolved = await resolveDefinition(testDb.db, tenantId, {
      kind: "saved",
      workflow_id: workflowAId,
    });
    expect(resolved.workflow_version_id).toBe(versionAId);
  });

  test("picks up an atomically promoted workflow version without a process restart", async () => {
    const before = await resolveDefinition(testDb.db, tenantId, {
      kind: "saved",
      workflow_id: workflowAId,
    });
    expect(before.workflow_version_id).toBe(versionAId);
    expect(before.def.max_llm_tokens_per_run).toBeUndefined();

    const [promoted] = await testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenantId,
        workflow_id: workflowAId,
        version: 2,
        dag: {
          name: "a",
          max_llm_tokens_per_run: 70_000,
          steps: [{ id: "noop", kind: "transform", expression: "$input" }],
        },
      })
      .returning();
    if (!promoted) throw new Error("workflow version insert failed");

    try {
      await testDb.db
        .update(workflows)
        .set({ current_version_id: promoted.id })
        .where(eq(workflows.id, workflowAId));

      const after = await resolveDefinition(testDb.db, tenantId, {
        kind: "saved",
        workflow_id: workflowAId,
      });
      expect(after.workflow_version_id).toBe(promoted.id);
      expect(after.def.max_llm_tokens_per_run).toBe(70_000);
    } finally {
      await testDb.db
        .update(workflows)
        .set({ current_version_id: versionAId })
        .where(eq(workflows.id, workflowAId));
    }
  });

  test("refuses to run an archived workflow", async () => {
    const [c] = await testDb.db
      .insert(workflows)
      .values({ tenant_id: tenantId, slug: "wf-c", name: "Workflow C", lifecycle: "archived" })
      .returning();
    const [vc] = await testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenantId,
        workflow_id: c!.id,
        version: 1,
        dag: { name: "c", steps: [{ id: "noop", kind: "transform", expression: "$input" }] },
      })
      .returning();
    await testDb.db
      .update(workflows)
      .set({ current_version_id: vc!.id })
      .where(eq(workflows.id, c!.id));

    await expect(
      resolveDefinition(testDb.db, tenantId, { kind: "saved", workflow_id: c!.id }),
    ).rejects.toThrow(/archived/);
  });
});
