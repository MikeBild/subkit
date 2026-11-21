import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  executions,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import {
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state/index.ts";
import type { DraftDocument } from "../types.ts";
import { commitWorkflowAtomic } from "./commit-workflow.ts";
import {
  ctx,
  freshConversation,
  readyDraft,
  seedApprovedConfirm,
  stubToolCtx,
  useCommitWorkflowGatesSetup,
} from "./commit-workflow-gates-fixtures.ts";

useCommitWorkflowGatesSetup();

test("inert authoring saves a scheduled draft without approval or trigger activation", async () => {
  const conversationId = await freshConversation();
  const draft = readyDraft("inert-authoring-schedule");
  draft.workflow.trigger = { kind: "schedule", cron: "0 8 * * *", tz: "Europe/Berlin" };
  const toolCtx = stubToolCtx(conversationId, draft);
  const result = await commitWorkflowAtomic({ ctx: toolCtx });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    activation_required: true,
    persistence_kind: "draft",
    version: 1,
  });
  const data = result.data as { workflow_id: string; workflow_version_id: string };
  const [saved] = await ctx.testDb.db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, data.workflow_id)));
  expect(saved?.current_version_id).toBeNull();
  expect(saved?.draft_version_id).toBe(data.workflow_version_id);
  expect(saved?.lifecycle).toBe("draft");
  expect(
    await ctx.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, ctx.tenant_id),
          eq(workflowsSchedules.workflow_id, data.workflow_id),
        ),
      ),
  ).toHaveLength(0);
  expect(toolCtx.getDraft().state?.persisted_resources[0]).toMatchObject({
    persistence_kind: "draft",
    version_id: data.workflow_version_id,
    current_version_id: null,
  });
  const audit = await ctx.testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, data.workflow_id)));
  expect(audit).toHaveLength(1);
  expect(audit[0]?.metadata).toMatchObject({ kind: "draft", request_source: "tool-chain" });
});

function sensitiveDraft(slug: string): DraftDocument {
  let draft: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name: slug,
      slug,
      execution_privacy: "sensitive",
      trigger: { kind: "schedule", cron: "0 8 * * *", tz: "Europe/Berlin" },
      steps: [
        {
          id: "echo",
          kind: "transform",
          expression: "return input.input;",
          language: "javascript",
        },
      ],
    },
  };
  draft = withWorkflowInspection(draft);
  return withWorkflowValidation(draft, true, "Sensitive definition structurally validated.");
}

function sensitiveMetadataPreview(draft: DraftDocument, ok: boolean): DraftDocument {
  return withLatestPreview(draft, {
    ok,
    step_id: "echo",
    summary: ok
      ? "Sensitive test run succeeded: 1 step(s), 1 succeeded, 0 failed, 0 held."
      : "Sensitive test run failed: 1 step(s), 0 succeeded, 1 failed, 0 held.",
    preview: null,
    step_traces: [
      {
        step_id: "echo",
        kind: "transform",
        status: ok ? "succeeded" : "failed",
        ...(ok ? {} : { error_code: "sensitive_execution_failure" }),
      },
    ],
    input: null,
  });
}

test("a sensitive definition without a metadata test run is not saved", async () => {
  const conversationId = await freshConversation();
  await seedApprovedConfirm(conversationId);
  const result = await commitWorkflowAtomic({
    ctx: stubToolCtx(conversationId, sensitiveDraft("sensitive-no-test-run")),
  });
  expect(result).toMatchObject({ ok: false, error_code: "workflow_not_ready" });
  if (!result.ok) expect(result.next_best_actions).toContain("dry_run_workflow");
});

test("an approved sensitive definition saves inactive after a green schema-only check", async () => {
  const conversationId = await freshConversation();
  await seedApprovedConfirm(conversationId);
  const draft = withLatestPreview(sensitiveDraft("sensitive-schema-only-save"), {
    ok: true,
    step_id: "echo",
    summary: "Structure checked, content not checked.",
    preview: null,
    input: null,
    redacted: true,
    mode: "schema_only",
  });
  const result = await commitWorkflowAtomic({ ctx: stubToolCtx(conversationId, draft) });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    activation_required: true,
    persistence_kind: "draft",
    runtime_verification: "schema_only",
  });
  expect(
    String((result.data as { verification_guidance: string }).verification_guidance),
  ).toContain("Cockpit");
});

test("an approved sensitive definition saves inactive after a green metadata test run", async () => {
  const conversationId = await freshConversation();
  await seedApprovedConfirm(conversationId);
  const toolCtx = stubToolCtx(
    conversationId,
    sensitiveMetadataPreview(sensitiveDraft("sensitive-inert-save"), true),
  );
  const result = await commitWorkflowAtomic({ ctx: toolCtx });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    activation_required: true,
    persistence_kind: "draft",
    runtime_verification: "metadata_only",
  });
  const data = result.data as { workflow_id: string; workflow_version_id: string };
  const [saved] = await ctx.testDb.db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, data.workflow_id)));
  expect(saved).toMatchObject({
    lifecycle: "draft",
    current_version_id: null,
    draft_version_id: data.workflow_version_id,
  });
  const [version] = await ctx.testDb.db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, ctx.tenant_id),
        eq(workflowVersions.id, data.workflow_version_id),
      ),
    );
  expect(version?.dag).toMatchObject({ execution_privacy: "sensitive" });
  for (const table of [
    workflowsSchedules,
    webhooksInbound,
    executions,
    workflowExecutionAuthorities,
  ]) {
    expect(
      await ctx.testDb.db
        .select()
        .from(table)
        .where(and(eq(table.tenant_id, ctx.tenant_id), eq(table.workflow_id, data.workflow_id))),
    ).toHaveLength(0);
  }
  const audit = await ctx.testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, data.workflow_id)));
  expect(audit).toHaveLength(1);
  expect(audit[0]?.metadata).toMatchObject({ runtime_verification: "metadata_only" });
});

test("a sensitive save without a test run does not claim a metadata test run", async () => {
  const conversationId = await freshConversation();
  await seedApprovedConfirm(conversationId);
  const toolCtx = {
    ...stubToolCtx(conversationId, sensitiveDraft("sensitive-no-run-by-user")),
    recentUserMessage: "Bitte keinen Testlauf starten.",
  };
  const result = await commitWorkflowAtomic({ ctx: toolCtx });
  expect(result.ok).toBe(true);
  const data = result.data as { runtime_verification: string; verification_guidance: string };
  expect(data.runtime_verification).toBe("not_performed");
  expect(data.verification_guidance).not.toContain("returned metadata only");
  expect(data.verification_guidance).toContain("no test run");
});

test("a failed sensitive metadata test run blocks saving and cannot be forced", async () => {
  const conversationId = await freshConversation();
  await seedApprovedConfirm(conversationId);
  const draft = sensitiveMetadataPreview(sensitiveDraft("sensitive-failed-test-run"), false);
  const result = await commitWorkflowAtomic({ ctx: stubToolCtx(conversationId, draft) });
  expect(result).toMatchObject({ ok: false, error_code: "preview_failed" });
  const forced = await commitWorkflowAtomic({
    ctx: stubToolCtx(conversationId, draft),
    forceCommit: true,
  });
  expect(forced).toMatchObject({ ok: false, error_code: "sensitive_save_override_forbidden" });
});

test("sensitive inert save retains the human confirmation gate when the person asks before writing", async () => {
  const conversationId = await freshConversation();
  const toolCtx = stubToolCtx(conversationId, sensitiveDraft("sensitive-no-approval"));
  toolCtx.ask_before_writing = true;
  const result = await commitWorkflowAtomic({ ctx: toolCtx });
  expect(result.ok).toBe(false);
  expect(result.data).toMatchObject({ error_code: "no_prior_approval" });
});

test("sensitive inert save rejects stale inspection and validation even with preview evidence", async () => {
  const conversationId = await freshConversation();
  await seedApprovedConfirm(conversationId);
  let draft = sensitiveDraft("sensitive-stale");
  draft = withWorkflowDraft(draft, { ...draft.workflow, description: "Changed after validation" });
  draft = withLatestPreview(draft, { ok: true, summary: "Earlier ordinary preview", warnings: [] });
  const result = await commitWorkflowAtomic({ ctx: stubToolCtx(conversationId, draft) });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error_code).toBe("workflow_not_ready");
});

test("sensitive inert save rejects failed validation and force overrides", async () => {
  const conversationId = await freshConversation();
  await seedApprovedConfirm(conversationId);
  const draft = sensitiveDraft("sensitive-invalid");
  const invalid = withWorkflowValidation(draft, false, "Invalid definition.");
  const result = await commitWorkflowAtomic({ ctx: stubToolCtx(conversationId, invalid) });
  expect(result.ok).toBe(false);
  const forced = await commitWorkflowAtomic({
    ctx: stubToolCtx(conversationId, draft),
    forceCommit: true,
  });
  expect(forced).toMatchObject({ ok: false, error_code: "sensitive_save_override_forbidden" });
});

test("ordinary definitions still require a fresh preview", async () => {
  const conversationId = await freshConversation();
  await seedApprovedConfirm(conversationId);
  let draft: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name: "ordinary-no-preview",
      steps: [
        {
          id: "echo",
          kind: "transform",
          expression: "return input.input;",
          language: "javascript",
        },
      ],
    },
  };
  draft = withWorkflowValidation(withWorkflowInspection(draft), true, "Validated.");
  const result = await commitWorkflowAtomic({ ctx: stubToolCtx(conversationId, draft) });
  expect(result).toMatchObject({ ok: false, error_code: "workflow_not_ready" });
  if (!result.ok) expect(result.next_best_actions).toContain("dry_run_workflow");
});
