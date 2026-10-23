import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import {
  auditLog,
  conversationElicitations,
  conversations,
  executions,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createWorkflow } from "../../workflows/service.ts";
import {
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
import { loadDraft } from "../draft.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { commitWorkflowAtomic } from "./commit-workflow.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("commit_gates");
});

afterAll(async () => {
  await ctx.cleanup();
});

function readyDraft(slug: string, name = slug): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name,
      slug,
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
  let draft = withWorkflowInspection(base);
  draft = withWorkflowValidation(draft, true, "Workflow draft validated.");
  draft = withLatestPreview(draft, {
    ok: true,
    summary: "preview ok",
    warnings: [],
  });
  return draft;
}

function draftWithFailedPreview(
  slug: string,
  failureKind: "runtime_data" | "config_invalid",
): DraftDocument {
  const base = readyDraft(slug);
  const stepTrace =
    failureKind === "runtime_data"
      ? {
          step_id: "echo",
          kind: "request" as const,
          status: "failed" as const,
          request_meta: { status: 404 },
        }
      : {
          step_id: "echo",
          kind: "request" as const,
          status: "error" as const,
          error_code: "unresolved_identifier",
        };
  return withLatestPreview(base, {
    ok: false,
    summary: "preview failed",
    warnings: [],
    step_traces: [stepTrace],
  });
}

async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

async function seedApprovedConfirm(conversationId: string): Promise<void> {
  await ctx.testDb.db.insert(conversationElicitations).values({
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    tool_name: "ask_user_confirm",
    summary: "commit",
    input: {
      kind: "save_workflow_draft",
      summary: "commit",
      commit_intent: { kind: "save_workflow_draft", payload: {}, description: "commit" },
    },
    output: { confirmed: true },
    status: "resolved",
  });
}

function stubToolCtx(conversationId: string, draft: DraftDocument): ToolContext {
  let live = draft;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    // biome-ignore lint/suspicious/noExplicitAny: minimal engineClient stub
    engineClient: {} as any,
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
      await ctx.testDb.db
        .update(conversations)
        .set({ draft: next })
        .where(
          and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversationId)),
        );
    },
  };
}

async function observedEdit(conversationId: string, next: DraftDocument): Promise<DraftDocument> {
  const previous = await loadDraft(ctx.tenant_id, conversationId, ctx.testDb.db);
  if (!next.state) throw new Error("expected normalized editing state");
  return {
    ...next,
    state: { ...next.state, persisted_resources: previous.state?.persisted_resources ?? [] },
  };
}

test("inert authoring saves a scheduled draft without approval or trigger activation", async () => {
  const conversationId = await freshConversation();
  const draft = readyDraft("inert-authoring-schedule");
  draft.workflow.trigger = { kind: "schedule", cron: "0 8 * * *", tz: "Europe/Berlin" };
  const toolCtx = stubToolCtx(conversationId, draft);
  toolCtx.permission_mode = "auto";
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

test("sensitive inert save retains the human confirmation gate", async () => {
  const conversationId = await freshConversation();
  const result = await commitWorkflowAtomic({
    ctx: stubToolCtx(conversationId, sensitiveDraft("sensitive-no-approval")),
  });
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

describe("C.1 — same-slug adoption", () => {
  test("re-commit same slug increments version (no -v2 slug)", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);

    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("adopt-slug", "Adopt Slug")),
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { workflow_id: string; version: number; slug: string };
    expect(firstData.slug).toBe("adopt-slug");

    await seedApprovedConfirm(conversationId);
    const second = await commitWorkflowAtomic({
      ctx: stubToolCtx(
        conversationId,
        await observedEdit(conversationId, readyDraft("adopt-slug", "Adopt Slug v2")),
      ),
    });
    expect(second.ok).toBe(true);
    const secondData = second.data as { workflow_id: string; version: number; slug: string };

    expect(secondData.workflow_id).toBe(firstData.workflow_id);
    expect(secondData.version).toBeGreaterThan(firstData.version);
    expect(secondData.slug).toBe("adopt-slug");

    const live = await ctx.testDb.db
      .select({ slug: workflows.slug })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.slug, "adopt-slug"),
          isNull(workflows.deleted_at),
        ),
      );
    expect(live).toHaveLength(1);
  });
});

describe("C.2 — preview-failure-class gate", () => {
  test("force_commit:true + runtime_data failure → commit succeeds", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    const draft = draftWithFailedPreview("runtime-fail-wf", "runtime_data");

    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, draft),
      forceCommit: true,
      skipPriorApprovalCheck: true,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { preview_failure_class?: string };
    expect(result.ok).toBe(true);
    void data;
  });

  test("force_commit over runtime_data threads forced_over_runtime_data into the workflow audit", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    const draft = draftWithFailedPreview("runtime-fail-audit-wf", "runtime_data");

    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, draft),
      forceCommit: true,
      skipPriorApprovalCheck: true,
      emitAutoPersistAudit: true,
    });
    expect(result.ok).toBe(true);
    const workflowId = (result.data as { workflow_id?: string }).workflow_id;
    expect(workflowId).toBeDefined();

    const rows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, workflowId as string)),
      );
    const forced = rows.find(
      (r) =>
        (r.metadata as { forced_over_runtime_data?: boolean }).forced_over_runtime_data === true,
    );
    expect(forced).toBeDefined();
    expect((forced!.metadata as { preview_failure_class?: string }).preview_failure_class).toBe(
      "runtime_data",
    );
  });

  test("force_commit:true + config_invalid failure (unresolved_identifier) → blocked", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    const draft = draftWithFailedPreview("config-fail-wf", "config_invalid");

    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, draft),
      forceCommit: true,
      skipPriorApprovalCheck: true,
    });
    expect(result.ok).toBe(false);
    const res = result as {
      error_code?: string;
      data?: { preview_failure_class?: string; force_commit_available?: boolean };
    };
    expect(res.error_code).toBe("preview_failed");
    expect(res.data?.preview_failure_class).toBe("config_invalid");
    expect(res.data?.force_commit_available).toBe(false);
  });
});

describe("C.4 — saving never changes live webhook bindings", () => {
  for (const forceCommit of [false, true]) {
    test(`a saved trigger removal leaves the active webhook intact (force=${forceCommit})`, async () => {
      const conversationId = await freshConversation();
      const slug = `wh-inert-${forceCommit}`;
      const live = await createWorkflow(
        {
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          def: {
            ...readyDraft(slug).workflow,
            trigger: {
              kind: "webhook",
              source: "stripe",
              events: [],
              verify: "stripe-signature",
            },
          },
        },
        ctx.testDb.db,
      );
      if (!live.workflow) throw new Error(live.errors.join("; "));
      const workflowId = live.workflow.id;
      await ctx.testDb.db
        .update(conversations)
        .set({ target_workflow_id: workflowId })
        .where(
          and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversationId)),
        );
      const before = await ctx.testDb.db
        .select()
        .from(webhooksInbound)
        .where(
          and(
            eq(webhooksInbound.tenant_id, ctx.tenant_id),
            eq(webhooksInbound.workflow_id, workflowId),
          ),
        );
      expect(before).toHaveLength(1);
      const result = await commitWorkflowAtomic({
        ctx: stubToolCtx(conversationId, await observedEdit(conversationId, readyDraft(slug))),
        skipPriorApprovalCheck: true,
        forceCommit,
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        activation_required: true,
        current_version_id: live.workflow.current_version_id,
      });
      expect(
        await ctx.testDb.db
          .select()
          .from(webhooksInbound)
          .where(
            and(
              eq(webhooksInbound.tenant_id, ctx.tenant_id),
              eq(webhooksInbound.workflow_id, workflowId),
            ),
          ),
      ).toEqual(before);
      const [stillLive] = await ctx.testDb.db
        .select()
        .from(workflows)
        .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflowId)));
      expect(stillLive?.current_version_id).toBe(live.workflow.current_version_id);
      expect(stillLive?.draft_version_id).not.toBe(stillLive?.current_version_id);
    });
  }
});

describe("C.3 — already_persisted idempotency", () => {
  test("re-commit byte-identical draft → already_persisted:true, no new version, one audit row", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    const draft = readyDraft("idempotent-commit", "Idempotent");

    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, await observedEdit(conversationId, draft)),
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { workflow_id: string; version: number };

    const auditAfterFirst = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.resource_id, firstData.workflow_id),
          eq(auditLog.action, "workflow.created"),
        ),
      );
    const createdCount = auditAfterFirst.length;
    expect(createdCount).toBe(1);

    await seedApprovedConfirm(conversationId);
    const second = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, await observedEdit(conversationId, draft)),
    });
    expect(second.ok).toBe(true);
    const secondData = second.data as {
      already_persisted?: boolean;
      version_changed?: boolean;
      workflow_id: string;
    };
    expect(secondData.already_persisted).toBe(true);
    expect(secondData.version_changed).toBe(false);
    expect(secondData.workflow_id).toBe(firstData.workflow_id);
    expect(second.committed_workflow_id).toBeUndefined();

    const auditAfterSecond = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.resource_id, firstData.workflow_id),
          eq(auditLog.action, "workflow.created"),
        ),
      );
    expect(auditAfterSecond).toHaveLength(1);
  });
});

describe("M4 — unbound-schedule warning on the commit envelope", () => {
  test("cadence phrasing with no schedule trigger surfaces schedule_warning + next_prompt banner", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);

    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("daily-digest-m4", "Daily digest at 9:00")),
    });
    expect(result.ok).toBe(true);
    const data = result.data as { schedule_warning?: string; next_prompt?: string };
    expect(data.schedule_warning).toBeDefined();
    expect(data.schedule_warning).toContain("NO schedule trigger");
    expect(data.next_prompt).toContain("WARNING");
  });

  test("no cadence phrasing → no schedule_warning on the envelope", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);

    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("plain-echo-m4", "Echo transformer")),
    });
    expect(result.ok).toBe(true);
    const data = result.data as { schedule_warning?: string; next_prompt?: string };
    expect(data.schedule_warning).toBeUndefined();
    expect(data.next_prompt ?? "").not.toContain("WARNING");
  });
});

describe("C.5 — schedule activation is not draft persistence", () => {
  const trigger = { kind: "schedule" as const, cron: "0 7 * * *", tz: "Europe/Berlin" };
  for (const forceCommit of [false, true]) {
    test(`saving a schedule starts nothing (force=${forceCommit})`, async () => {
      const conversationId = await freshConversation();
      const draft = readyDraft(`sched-inert-${forceCommit}`);
      draft.workflow.trigger = trigger;
      const result = await commitWorkflowAtomic({
        ctx: stubToolCtx(conversationId, draft),
        skipPriorApprovalCheck: true,
        forceCommit,
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ activation_required: true, current_version_id: null });
      const workflowId = (result.data as { workflow_id: string }).workflow_id;
      expect(
        await ctx.testDb.db
          .select()
          .from(workflowsSchedules)
          .where(
            and(
              eq(workflowsSchedules.tenant_id, ctx.tenant_id),
              eq(workflowsSchedules.workflow_id, workflowId),
            ),
          ),
      ).toHaveLength(0);
    });
  }

  test("editing a scheduled workflow preserves its exact active version and schedule", async () => {
    const conversationId = await freshConversation();
    const slug = "sched-inert-edit";
    const live = await createWorkflow(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        def: { ...readyDraft(slug).workflow, trigger },
      },
      ctx.testDb.db,
    );
    if (!live.workflow) throw new Error(live.errors.join("; "));
    const workflowId = live.workflow.id;
    await ctx.testDb.db
      .update(conversations)
      .set({ target_workflow_id: workflowId })
      .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversationId)));
    const before = await ctx.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, ctx.tenant_id),
          eq(workflowsSchedules.workflow_id, workflowId),
        ),
      );
    expect(before).toHaveLength(1);
    const edited = readyDraft(slug, "Changed draft only");
    edited.workflow.trigger = trigger;
    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, await observedEdit(conversationId, edited)),
      skipPriorApprovalCheck: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      activation_required: true,
      current_version_id: live.workflow.current_version_id,
    });
    expect(
      await ctx.testDb.db
        .select()
        .from(workflowsSchedules)
        .where(
          and(
            eq(workflowsSchedules.tenant_id, ctx.tenant_id),
            eq(workflowsSchedules.workflow_id, workflowId),
          ),
        ),
    ).toEqual(before);
  });

  test("saving a request workflow does not implicitly activate it either", async () => {
    const conversationId = await freshConversation();
    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("request-inert")),
      skipPriorApprovalCheck: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ activation_required: true, current_version_id: null });
  });
});
