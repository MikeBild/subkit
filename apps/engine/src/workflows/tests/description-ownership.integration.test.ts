import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { patchCandidates, tenants, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { approvePatchCandidate } from "../../self-healing/candidate-decision.ts";
import { activateReviewedDraft } from "../activate-reviewed-draft.ts";
import { saveWorkflowDraft } from "../drafts.ts";
import { createWorkflow, getWorkflow, updateWorkflow, updateWorkflowMetadata } from "../service.ts";
import { WorkflowDefSchema } from "../types.ts";
import { rotateWorkflowVersionInternal } from "../version-rotate.ts";
import { restoreWorkflowVersion } from "../versions.ts";

let ctx: TestDb;
let tenant_id = "";
let workflow_id = "";
const PERSON = "Sends the weekly report to finance.";

function definition(variant: string) {
  return WorkflowDefSchema.parse({
    name: "owned-report",
    slug: "owned-report",
    trigger: { kind: "request" },
    steps: [
      {
        id: "fetch",
        kind: "request",
        method: "GET",
        url: `https://reports.example.test/items?variant=${variant}`,
        data_selector: "$.data.id",
      },
    ],
  });
}

async function expectPersonsText(after: string) {
  const wf = await getWorkflow(tenant_id, workflow_id, ctx.db);
  expect(wf?.description, after).toBe(PERSON);
  expect(wf?.description_source, after).toBe("human");
}

beforeAll(async () => {
  ctx = await createTestDb("description_ownership");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-description-ownership", display_name: "Ownership" })
    .returning();
  tenant_id = t!.id;
  const created = await createWorkflow(
    { tenant_id, actor_id: null, def: definition("v1") },
    ctx.db,
  );
  workflow_id = created.workflow!.id;
  await updateWorkflowMetadata(
    { tenant_id, id: workflow_id, description: PERSON, actor_id: null },
    ctx.db,
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a person's workflow description survives every version writer", () => {
  test("update", async () => {
    await updateWorkflow(
      { tenant_id, id: workflow_id, actor_id: null, def: definition("v2") },
      ctx.db,
    );
    await expectPersonsText("update");
  });

  test("restore of an older version", async () => {
    await restoreWorkflowVersion(tenant_id, workflow_id, 1, null, ctx.db);
    await expectPersonsText("restore");
  });

  test("internal version rotation", async () => {
    await ctx.db.transaction((tx) =>
      rotateWorkflowVersionInternal(
        { tenant_id, workflow_id, def: definition("rotated"), note: "rotation" },
        tx,
      ),
    );
    await expectPersonsText("rotation");
  });

  test("an approved self-healing patch", async () => {
    const [candidate] = await ctx.db
      .insert(patchCandidates)
      .values({
        tenant_id,
        workflow_id,
        classification: "safe",
        status: "proposed",
        diff: {
          workflow_step_id: "fetch",
          proposal: {
            classification: "safe",
            kind: "update_field_path",
            description: "field moved",
            reasoning: "nested response",
            patch: { op: "replace", path: "/data/id", value: "data/result/id" },
          },
        },
      })
      .returning();
    await approvePatchCandidate({ tenant_id, candidate_id: candidate!.id, actor_id: null }, ctx.db);
    await expectPersonsText("patch approval");
  });

  test("activation of a reviewed draft", async () => {
    const [before] = await ctx.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)));
    const saved = await saveWorkflowDraft(
      {
        tenant_id,
        workflow_id,
        expected_draft_version_id: before!.draft_version_id,
        actor_id: null,
        request_source: "api",
        def: definition("draft"),
      },
      ctx.db,
    );
    const draftVersionId = "draft" in saved ? saved.draft?.version_id : undefined;
    expect(draftVersionId).toBeDefined();
    await ctx.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)));
      await activateReviewedDraft(
        tx,
        locked!,
        draftVersionId!,
        locked!.current_version_id,
        "00000000-0000-4000-8000-000000000001",
        false,
      );
    });
    await expectPersonsText("draft activation");
  });
});
