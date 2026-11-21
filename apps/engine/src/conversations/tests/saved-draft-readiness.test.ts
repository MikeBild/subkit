import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { workflows, workflowsSchedules, workflowVersions } from "../../db/schema/index.ts";
import { bindPersistedWorkflow, createEmptyDraftDocument } from "../authoring-state/index.ts";
import type { ToolContext } from "../tools/index.ts";
import { inspectWorkflowDraftTool } from "../tools/inspect-workflow-draft.ts";
import { savedDraftReadiness } from "../tools/saved-draft-readiness.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
let sequence = 0;
beforeAll(async () => {
  ctx = await createConversationTestCtx("saved-draft-readiness");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function seed(opts: { variables: Record<string, unknown>; scheduled: boolean }) {
  const slug = `readiness-${++sequence}`;
  const db = ctx.testDb.db;
  const [wf] = await db
    .insert(workflows)
    .values({ tenant_id: ctx.tenant_id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("workflow insert failed");
  const step = (boundary?: unknown) => ({
    id: "ingest",
    kind: "request",
    connector_id: ctx.connector_id,
    method: "POST",
    path: "/spaces/${input.space}/ingest",
    body: { title: "Findings ${scope.window.data.start}" },
    ...(boundary ? { boundary } : {}),
  });
  const version = async (n: number, steps: unknown[]) => {
    const [row] = await db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: wf.id,
        version: n,
        dag: { name: slug, slug, steps },
      })
      .returning();
    if (!row) throw new Error("version insert failed");
    return row.id;
  };
  const active = await version(1, [step()]);
  const draft = await version(2, [
    step({ variables: opts.variables, max_body_bytes: 1000, max_calls: 1 }),
  ]);
  await db
    .update(workflows)
    .set({ current_version_id: active, draft_version_id: draft })
    .where(eq(workflows.id, wf.id));
  if (opts.scheduled)
    await db.insert(workflowsSchedules).values({
      tenant_id: ctx.tenant_id,
      workflow_id: wf.id,
      cron: "0 5 * * *",
      timezone: "UTC",
      execution_mode: "dev",
      paused: false,
      input: { space: "reports" },
    });
  return wf.id;
}
const toolCtx = () => ({ db: ctx.testDb.db, tenant_id: ctx.tenant_id });

test("a body placeholder listed under variables is reported with its remedy at save time", async () => {
  const readiness = await savedDraftReadiness(
    toolCtx(),
    await seed({
      variables: {
        "input.space": { enum: ["reports"] },
        "scope.window.data.start": { class: "timestamp" },
      },
      scheduled: true,
    }),
  );
  expect(readiness?.eligible_for_repeated_runs).toBe(false);
  expect(readiness?.issues).toEqual([{ step_id: "ingest", code: "dynamic_request" }]);
  expect(readiness?.repair_guidance?.[0]?.instruction).toContain("only in the body gets no entry");
  expect(readiness?.message).toContain("ends the turn");
});

test("the corrected boundary is reported eligible", async () => {
  const readiness = await savedDraftReadiness(
    toolCtx(),
    await seed({ variables: { "input.space": { enum: ["reports"] } }, scheduled: true }),
  );
  expect(readiness).toMatchObject({ eligible_for_repeated_runs: true });
  expect(readiness?.issues).toBeUndefined();
});

test("an unscheduled saved change still hands over to the review that applies it", async () => {
  const id = await seed({ variables: { "input.space": { enum: ["reports"] } }, scheduled: false });
  const readiness = await savedDraftReadiness(toolCtx(), id);
  expect(readiness?.issues).toBeUndefined();
  expect(readiness?.message).toContain("review_workflow_automation");
  expect(readiness?.message).not.toMatch(/curl -|\/v1\//);
  const [row] = await ctx.testDb.db
    .select({ draft: workflows.draft_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, id)));
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: row?.draft ?? null, draft_version_id: null })
    .where(eq(workflows.id, id));
  expect(await savedDraftReadiness(toolCtx(), id)).toBeNull();
});

const dynamicVariables = {
  "input.space": { enum: ["reports"] },
  "scope.window.data.start": { class: "timestamp" },
};

test("an unscheduled saved change reports its review issues at save time", async () => {
  const readiness = await savedDraftReadiness(
    toolCtx(),
    await seed({ variables: dynamicVariables, scheduled: false }),
  );
  expect(readiness?.eligible_for_repeated_runs).toBe(false);
  expect(readiness?.issues).toContainEqual({ step_id: "ingest", code: "dynamic_request" });
  expect(readiness?.repair_guidance?.length).toBeGreaterThan(0);
  expect(readiness?.environment).toBe("dev");
  expect(readiness?.message).toContain("review_workflow_automation");
});

test("inspecting a bound inactive draft surfaces its review issues and a held preview", async () => {
  const id = await seed({ variables: dynamicVariables, scheduled: false });
  const [row] = await ctx.testDb.db
    .select({ current: workflows.current_version_id, draft: workflows.draft_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, id)));
  let draft: DraftDocument = bindPersistedWorkflow(createEmptyDraftDocument(), {
    kind: "workflow",
    id,
    slug: null,
    name: "readiness",
    version_id: row?.draft ?? null,
    version: 2,
    draft_version_id: row?.draft ?? null,
    current_version_id: row?.current ?? null,
    persistence_kind: "draft",
    environment: null,
    saved_at: new Date(0).toISOString(),
  });
  const tool = {
    ...toolCtx(),
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  } as unknown as ToolContext;
  const result = await inspectWorkflowDraftTool.execute(tool, {});
  const data = result.data as {
    blocking_reasons: string[];
    summary: { blocked_by: string[]; next_suggested_tool: string | null; readiness: string };
    saved_draft_readiness?: { issues?: Array<{ code: string }> };
  };
  expect(data.blocking_reasons).toContain("automation_review_issues");
  expect(data.summary.blocked_by).toContain("automation_review_issues");
  expect(data.summary.next_suggested_tool).toBe("dry_run_workflow");
  expect(data.summary.readiness).not.toBe("saved");
  expect(data.saved_draft_readiness?.issues?.map((issue) => issue.code)).toContain(
    "dynamic_request",
  );
});
