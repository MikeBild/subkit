import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import {
  dataMigrations,
  tenants,
  users,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { executableDefinition } from "../stored-definition.ts";
import { MODEL_STEP_V1_BACKFILL_NAME, runModelStepV1Backfill } from "./model-step-v1.ts";

let ctx: TestDb;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  ctx = await createTestDb("model_step_backfill");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-model-step", display_name: "ModelStep" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "owner@example.test",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!user) throw new Error("seed user failed");
  userId = user.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

const schema = {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
};

const providerCall = (name: string) => ({
  name,
  steps: [
    {
      id: "ask",
      kind: "request",
      method: "POST",
      url: "https://api.openai.com/v1/responses",
      body: {
        model: "gpt-4.1-mini",
        input: "Summarize ${input.text}",
        text: { format: { type: "json_schema", schema } },
      },
    },
  ],
});

test("provider calls become model steps; approved versions are replaced, never edited", async () => {
  const plain = await seed("model-plain", providerCall("plain"));
  const approved = await seed("model-approved", providerCall("approved"), true);
  const read = await seed("model-read", {
    name: "read",
    steps: [
      ...providerCall("read").steps,
      { id: "use", kind: "transform", expression: "return input.scope.ask.data;" },
    ],
  });
  const before = { approved: await versionsOf(approved), read: await versionsOf(read) };
  await ctx.db.delete(dataMigrations).where(eq(dataMigrations.name, MODEL_STEP_V1_BACKFILL_NAME));

  const report = await runModelStepV1Backfill(ctx.db);
  expect(report).toEqual({
    skipped: false,
    rewritten: 1,
    rotated: 1,
    left_in_old_format: 0,
    kept_as_request: 1,
  });

  const plainAfter = await versionsOf(plain);
  expect(plainAfter).toHaveLength(1);
  expect(executableDefinition(plainAfter[0]?.dag).steps).toEqual([
    {
      id: "ask",
      kind: "model",
      on_error: "fail",
      prompt: "Summarize ${input.text}",
      output_schema: schema,
    },
  ]);

  const approvedAfter = await versionsOf(approved);
  expect(approvedAfter).toHaveLength(2);
  expect(approvedAfter[0]?.dag).toEqual(before.approved[0]?.dag);
  expect(executableDefinition(approvedAfter[1]?.dag).steps[0]).toMatchObject({ kind: "model" });

  expect(await versionsOf(read)).toEqual(before.read);
  expect((await runModelStepV1Backfill(ctx.db)).skipped).toBe(true);
});

async function seed(slug: string, dag: Record<string, unknown>, approved = false) {
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id: tenantId, workflow_id: workflow.id, version: 1, dag })
    .returning();
  if (!version) throw new Error("version insert failed");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, workflow.id)));
  if (approved)
    await ctx.db.insert(workflowExecutionAuthorities).values({
      tenant_id: tenantId,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      effect_manifest_digest: "0".repeat(64),
      effect_manifest: {},
      execution_environment: "dev",
      target_constraints: { targets: [] },
      created_by: userId,
    });
  return workflow.id;
}

async function versionsOf(workflow_id: string) {
  return ctx.db
    .select()
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, tenantId), eq(workflowVersions.workflow_id, workflow_id)),
    )
    .orderBy(asc(workflowVersions.version));
}
