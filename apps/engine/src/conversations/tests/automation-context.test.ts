import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { workflows, workflowsSchedules, workflowVersions } from "../../db/schema/index.ts";
import { renderAutomationContext } from "../automation-context.ts";
import { listSchedulesTool } from "../tools/generated/writes/schedules.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("automation_context");
});
afterAll(async () => {
  await ctx.cleanup();
});

test("current blocked status overrides historical preview success without exposing it to another tenant", async () => {
  const [workflow] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "blocked-context",
      name: "Blocked report",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("missing workflow");
  const [version] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: "Blocked report",
        steps: [
          { id: "send", kind: "request", method: "POST", url: "https://example.test/report" },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("missing version");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflow.id)));
  await ctx.testDb.db.insert(workflowsSchedules).values({
    tenant_id: ctx.tenant_id,
    workflow_id: workflow.id,
    cron: "0 9 * * *",
    execution_mode: "prod",
    admission_hold: {
      reason_code: "execution_authority_unavailable",
      observed_at: "2026-01-01T00:00:00Z",
    },
  });
  const principal: ResolvedPrincipal = {
    provider: "session",
    kind: "user",
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
  };
  const block = await renderAutomationContext(ctx.tenant_id, workflow.id, principal, ctx.testDb.db);
  expect(block).toContain('"state":"approval_required"');
  expect(block).toContain('"ready":false');
  expect(block).toContain("NOT execution permission");
  const denied = await renderAutomationContext(
    ctx.tenant_id,
    workflow.id,
    { ...principal, tenant_id: "00000000-0000-4000-8000-000000000099" },
    ctx.testDb.db,
  );
  expect(denied).not.toContain(workflow.id);
  expect(denied).toContain("cannot be verified");
  const absent = await renderAutomationContext(ctx.tenant_id, workflow.id, null, ctx.testDb.db);
  expect(absent).not.toContain('"state":');
  expect(listSchedulesTool.description).toContain("Keeping a cadence is not granting permission");
});
