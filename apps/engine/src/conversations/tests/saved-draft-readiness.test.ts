// The save result says whether the saved change is eligible for repeated runs.
//
// `review_workflow_automation` ends the turn, so an author who learns of a
// refused boundary only there cannot repair it. On a real repair two steps
// listed a BODY placeholder under `boundary.variables`; the preview was green,
// the draft was saved, and the human got a card that said "still blocked".

import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { workflows, workflowsSchedules, workflowVersions } from "../../db/schema/index.ts";
import { savedDraftReadiness } from "../tools/saved-draft-readiness.ts";
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    path: "/spaces/${input.space}/ingest",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
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
      // The fixture connector lives in dev; another mode is a different finding.
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
  // The reason this rides on the save result at all.
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
  // No recurring permission is asked for, but nothing runs the change until a
  // person applies it — without this the author reached for run_workflow and
  // met a refusal naming a dialog it had never shown.
  expect(readiness?.issues).toBeUndefined();
  expect(readiness?.message).toContain("review_workflow_automation");
  expect(readiness?.message).not.toMatch(/curl -|\/v1\//);
  // Once applied, nothing waits and nothing is said.
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
