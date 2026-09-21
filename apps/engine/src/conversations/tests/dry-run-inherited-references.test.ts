// The dry run refuses a draft only over references it introduces over the
// active version, and the notice about the inherited ones stays out of the
// preview's warnings: those are replayed to the author next turn as failures
// to repair, which is the one thing this notice must not cause.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0xd47_417ed);
const PLAN =
  "const current = input.scope.rollup_window\n  ? input.scope.rollup_window.data\n  : input.scope.window.data;\nreturn current;";
const steps = (plan: string) => [
  {
    id: "rollup_window",
    kind: "transform",
    language: "javascript",
    expression: "return { a: 1 };",
  },
  { id: "comparison_plan", kind: "transform", language: "javascript", expression: plan },
];

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-inherited-refs");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function bound(slug: string): Promise<string> {
  const db = ctx.testDb.db;
  const [wf] = await db
    .insert(workflows)
    .values({ tenant_id: ctx.tenant_id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("workflow insert failed");
  const [version] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: wf.id,
      version: 1,
      dag: { name: slug, slug, steps: steps(PLAN) },
    })
    .returning();
  if (!version) throw new Error("version insert failed");
  await db.update(workflows).set({ current_version_id: version.id }).where(eq(workflows.id, wf.id));
  const [conv] = await db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active", target_workflow_id: wf.id })
    .returning();
  if (!conv) throw new Error("conversation insert failed");
  return conv.id;
}

async function dryRun(conversation_id: string, slug: string, plan: string) {
  let draft = { workflow: { name: slug, slug, steps: steps(plan) } } as unknown as DraftDocument;
  const toolCtx: ToolContext = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
  };
  const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
  return { result, data: result.data as Record<string, unknown>, draft: () => draft };
}

test("a bound draft runs; the notice rides in the result and never in the preview warnings", async () => {
  const run = await dryRun(await bound("rollup-dry"), "rollup-dry", PLAN);
  expect(run.result.ok).toBe(true);
  expect(run.data.inherited_step_references).toMatchObject({ code: "inherited_step_reference" });
  expect(JSON.stringify(run.draft().latest_preview ?? {})).not.toContain(
    "inherited_step_reference",
  );
});

test("an unbound draft with the same read is still refused before anything runs", async () => {
  const run = await dryRun(uuid(), "unbound-dry", PLAN);
  expect(run.data.error_code).toBe("workflow_unresolved_step_reference");
});

test("a typo on top of an inherited read is refused, naming only the typo", async () => {
  const run = await dryRun(
    await bound("rollup-typo"),
    "rollup-typo",
    `${PLAN.replace("return current;", "return input.scope.rolup_window;")}`,
  );
  expect(run.data.error_code).toBe("workflow_unresolved_step_reference");
  const listed = run.data.unresolved_references as Array<{ bad_reference: string }>;
  expect(listed.map((e) => e.bad_reference)).toEqual(["rolup_window"]);
  expect(String(run.data.message)).not.toContain("`window`");
});
