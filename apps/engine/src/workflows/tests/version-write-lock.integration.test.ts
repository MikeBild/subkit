import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import { patchCandidates, tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { approvePatchCandidate } from "../../self-healing/candidate-decision.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { saveWorkflowDraft } from "../drafts.ts";
import { createWorkflow, updateWorkflow } from "../service.ts";
import { WorkflowDefSchema } from "../types.ts";
import { rotateWorkflowVersionInternal } from "../version-rotate.ts";
import { lockWorkflowForVersionWrite } from "../version-write-lock.ts";
import { restoreWorkflowVersion } from "../versions.ts";

let ctx: TestDb;
let tenant_id: string;
beforeAll(async () => {
  ctx = await createTestDb("version_write_lock");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "version-writer", display_name: "Writer" })
    .returning();
  if (!tenant) throw new Error("test tenant missing");
  tenant_id = tenant.id;
});
afterAll(async () => {
  await ctx.cleanup();
});

function definition(slug: string, description: string) {
  return WorkflowDefSchema.parse({
    name: slug,
    slug,
    description,
    trigger: { kind: "request" },
    steps: [
      {
        id: "fetch",
        kind: "request",
        method: "GET",
        url: `https://example.test/items?variant=${encodeURIComponent(description)}`,
        data_selector: "$.data.id",
      },
    ],
  });
}

for (const writer of ["restore", "rotation", "repair"] as const) {
  test(`${writer} waits for draft allocation before reading the next workflow version`, async () => {
    const initial = await createWorkflow(
      { tenant_id, actor_id: null, def: definition(writer, "initial") },
      ctx.db,
    );
    if (!initial.workflow) throw new Error(initial.errors.join("; "));
    const id = initial.workflow.id;
    const proposal = {
      classification: "safe",
      kind: "update_field_path",
      description: "field moved",
      reasoning: "nested response",
      patch: { op: "replace", path: "/data/id", value: "data/result/id" },
    };
    const [candidate] = await ctx.db
      .insert(patchCandidates)
      .values({
        tenant_id,
        workflow_id: id,
        classification: "safe",
        status: "proposed",
        diff: { workflow_step_id: "fetch", proposal },
      })
      .returning();
    if (!candidate) throw new Error("test candidate missing");
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = ctx.db.transaction(async (tx) => {
      if (!(await lockWorkflowForVersionWrite(tx, tenant_id, id)))
        throw new Error("test workflow missing");
      locked.resolve();
      await release.promise;
      return saveWorkflowDraft(
        {
          tenant_id,
          workflow_id: id,
          expected_draft_version_id: null,
          actor_id: null,
          request_source: "api",
          def: definition(writer, "inert draft"),
        },
        tx,
      );
    });
    await locked.promise;
    const writing =
      writer === "restore"
        ? restoreWorkflowVersion(tenant_id, id, 1, null, ctx.db)
        : writer === "rotation"
          ? ctx.db.transaction((tx) =>
              rotateWorkflowVersionInternal(
                {
                  tenant_id,
                  workflow_id: id,
                  def: definition(writer, "rotated"),
                  note: "test rotation",
                },
                tx,
              ),
            )
          : approvePatchCandidate(
              { tenant_id, candidate_id: candidate.id, actor_id: null },
              ctx.db,
            );
    const completed = Promise.allSettled([holder, writing]);
    try {
      await waitFor(
        async () => {
          const result = await ctx.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%for update%'",
          );
          return Number(result.rows[0]?.count) > 0;
        },
        { label: `${writer} workflow row lock`, tries: 200, sleepMs: 5 },
      );
      const before = await ctx.db
        .select()
        .from(workflowVersions)
        .where(
          and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, id)),
        );
      expect(before.map((row) => row.version)).toEqual([1]);
    } finally {
      release.resolve();
      await completed;
    }
    const draft = await holder;
    expect(draft.draft?.version).toBe(2);
    expect(await writing).toBeTruthy();
    const versions = await ctx.db
      .select()
      .from(workflowVersions)
      .where(and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, id)))
      .orderBy(asc(workflowVersions.version));
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
    const [workflow] = await ctx.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id)));
    expect(workflow?.draft_version_id).toBe(versions[1]?.id);
    expect(workflow?.current_version_id).toBe(versions[2]?.id);
  });
}

test("update fails fast while draft allocation owns catalog vocabulary", async () => {
  const initial = await createWorkflow(
    { tenant_id, actor_id: null, def: definition("update", "initial") },
    ctx.db,
  );
  if (!initial.workflow) throw new Error(initial.errors.join("; "));
  const id = initial.workflow.id;
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = ctx.db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenant_id);
    const saved = await saveWorkflowDraft(
      {
        tenant_id,
        workflow_id: id,
        expected_draft_version_id: null,
        actor_id: null,
        request_source: "api",
        def: definition("update", "inert draft"),
      },
      tx,
    );
    locked.resolve();
    await release.promise;
    return saved;
  });
  await locked.promise;
  try {
    await expect(
      updateWorkflow(
        { tenant_id, id, actor_id: null, def: definition("update", "updated") },
        ctx.db,
      ),
    ).rejects.toMatchObject({ code: "40001" });
  } finally {
    release.resolve();
  }
  const draft = await holder;
  expect(draft.draft?.version).toBe(2);
  const versions = await ctx.db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, id)))
    .orderBy(asc(workflowVersions.version));
  expect(versions.map((row) => row.version)).toEqual([1, 2]);
  const retried = await updateWorkflow(
    { tenant_id, id, actor_id: null, def: definition("update", "updated") },
    ctx.db,
  );
  if (!retried.workflow) throw new Error(retried.errors.join("; "));
  const finalVersions = await ctx.db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, id)))
    .orderBy(asc(workflowVersions.version));
  expect(finalVersions.map((row) => row.version)).toEqual([1, 2, 3]);
  const [workflow] = await ctx.db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id)));
  expect(workflow?.draft_version_id).toBe(finalVersions[1]?.id);
  expect(workflow?.current_version_id).toBe(finalVersions[2]?.id);
});
