import { describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import {
  auditLog,
  conversations,
  webhooksInbound,
  workflows,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { createWorkflow } from "../../workflows/service.ts";
import { withLatestPreview } from "../authoring-state/index.ts";
import { loadDraft } from "../draft.ts";
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

async function observedEdit(conversationId: string, next: DraftDocument): Promise<DraftDocument> {
  const previous = await loadDraft(ctx.tenant_id, conversationId, ctx.testDb.db);
  if (!next.state) throw new Error("expected normalized editing state");
  return {
    ...next,
    state: { ...next.state, persisted_resources: previous.state?.persisted_resources ?? [] },
  };
}

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
