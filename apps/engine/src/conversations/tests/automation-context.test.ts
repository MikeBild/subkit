import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  executionSteps,
  executions,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { inspectHeldPreviewEvidence } from "../../workflows/report-delivery-proposal.ts";
import { renderAutomationContext } from "../automation-context.ts";
import { listSchedulesTool } from "../tools/engine-api/writes/schedules.ts";
import { reviewWorkflowAutomationTool } from "../tools/review-workflow-automation.ts";
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
      reason_code: "execution_authority_expired",
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
  expect(block).toContain("review_workflow_automation");
  const reviewContext = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    actor_id: ctx.user_id,
    conversation_id: "00000000-0000-4000-8000-000000000001",
    connector_id: null,
    workflow_id: workflow.id,
    principal,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
  const review = await reviewWorkflowAutomationTool.execute(reviewContext, {
    workflow_id: workflow.id,
  });
  expect(review).toMatchObject({
    ok: true,
    data: {
      kind: "workflow_automation_review",
      workflow_id: workflow.id,
      schedules: [{ state: "approval_required", ready: false, environment: "prod" }],
    },
  });
  const after = await renderAutomationContext(ctx.tenant_id, workflow.id, principal, ctx.testDb.db);
  expect(after).toContain('"state":"approval_required"');
  const [draft] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      version: 2,
      dag: {
        name: "Changed report",
        steps: [
          {
            id: "changed_send",
            kind: "request",
            method: "POST",
            url: "https://example.test/${input.target}",
          },
        ],
      },
    })
    .returning();
  if (!draft) throw new Error("missing draft");
  await ctx.testDb.db
    .update(workflows)
    .set({ draft_version_id: draft.id })
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflow.id)));
  const draftReview = await reviewWorkflowAutomationTool.execute(reviewContext, {
    workflow_id: workflow.id,
  });
  expect(draftReview).toMatchObject({
    data: {
      schedules: [
        {
          state: "approval_required",
          ready: false,
          review: {
            workflow_version_id: draft.id,
            is_draft: true,
            eligible_for_repeated_runs: false,
            issues: [{ step_id: "changed_send", code: "dynamic_request" }],
          },
        },
      ],
    },
  });
  const draftContext = await renderAutomationContext(
    ctx.tenant_id,
    workflow.id,
    principal,
    ctx.testDb.db,
  );
  expect(draftContext).toContain(draft.id);
  const [heldRun] = await ctx.testDb.db
    .insert(executions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      workflow_version_id: draft.id,
      hold_writes: true,
      status: "succeeded",
      execution_mode: "prod",
      request_source: "ui",
    })
    .returning();
  if (!heldRun) throw new Error("missing held run");
  await ctx.testDb.db.insert(executionSteps).values([
    {
      tenant_id: ctx.tenant_id,
      execution_id: heldRun.id,
      step_key: "fetch_report",
      kind: "request",
      status: "succeeded",
      request_meta: { extras: { held: true }, secret: "must-not-leak" },
    },
    {
      tenant_id: ctx.tenant_id,
      execution_id: heldRun.id,
      step_key: "send_email",
      kind: "request",
      status: "skipped",
    },
  ]);
  const evidenceInput = {
    tenant_id: ctx.tenant_id,
    workflow_id: workflow.id,
    workflow_version_id: draft.id,
    execution_environment: "prod" as const,
  };
  const evidence = await inspectHeldPreviewEvidence(evidenceInput, ctx.testDb.db);
  expect(evidence).toMatchObject({
    status: "succeeded",
    steps: expect.arrayContaining([
      { step_id: "fetch_report", status: "succeeded", held: true, report_boundary_observed: false },
      { step_id: "send_email", status: "skipped", held: false, report_boundary_observed: false },
    ]),
  });
  expect(JSON.stringify(evidence)).not.toContain("must-not-leak");
  expect(
    await inspectHeldPreviewEvidence(
      { ...evidenceInput, execution_environment: "dev" },
      ctx.testDb.db,
    ),
  ).toBeNull();
  expect(
    await inspectHeldPreviewEvidence(
      { ...evidenceInput, workflow_version_id: version.id },
      ctx.testDb.db,
    ),
  ).toBeNull();
  expect(
    await inspectHeldPreviewEvidence(
      { ...evidenceInput, tenant_id: "00000000-0000-4000-8000-000000000099" },
      ctx.testDb.db,
    ),
  ).toBeNull();
  const evidenceReview = await reviewWorkflowAutomationTool.execute(reviewContext, {
    workflow_id: workflow.id,
  });
  expect(JSON.stringify(evidenceReview)).toContain('"preview_evidence"');
  expect(JSON.stringify(evidenceReview)).toContain('"status":"skipped"');
  expect(draftContext).toContain("changed_send");
  const otherTenant = "00000000-0000-4000-8000-000000000099";
  const missing = await reviewWorkflowAutomationTool.execute(
    {
      ...reviewContext,
      tenant_id: otherTenant,
      engineClient: new EngineClient({
        tenant_id: otherTenant,
        actor_id: ctx.user_id,
        actor_type: "user",
        db: ctx.testDb.db,
      }),
    },
    { workflow_id: workflow.id },
  );
  expect(missing).toMatchObject({ ok: false, error_code: "workflow_not_found" });

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
