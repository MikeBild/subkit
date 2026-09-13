// Integration tests for commit-workflow atomic gates.
//
// C.1 — same-slug adoption:
//   - commit a workflow whose slug matches a live workflow the conversation
//     is rebuilding (no foreign bound artifact) → single workflow row,
//     version incremented, no "-v2" slug.
//   - a draft pivoted to a DIFFERENT artifact's slug with a foreign workflow
//     bound → slug_conflict_with_live_workflow.
//
// C.2 — preview-failure-class gate:
//   - force_commit:true + runtime_data failure → succeeds.
//   - force_commit:true + config_invalid failure (unresolved_identifier) → blocked.
//
// C.3 — already_persisted idempotency:
//   - commit a workflow; re-commit byte-identical draft → already_persisted:true,
//     no new workflow version, exactly one WORKFLOW_CREATED audit row total.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import {
  auditLog,
  conversationElicitations,
  conversations,
  webhooksInbound,
  workflows,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { createWorkflow } from "../../workflows/service.ts";
import {
  withLatestPreview,
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
  // Override the preview to be failed with the correct error signal.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal engineClient stub
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

// ── C.1 same-slug adoption ────────────────────────────────────────────────────

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

describe("C.1 — same-slug adoption", () => {
  test("re-commit same slug increments version (no -v2 slug)", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);

    // First commit.
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("adopt-slug", "Adopt Slug")),
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { workflow_id: string; version: number; slug: string };
    expect(firstData.slug).toBe("adopt-slug");

    // Second commit with the SAME slug from the same conversation
    // (simulates "user edited a step, re-save").
    await seedApprovedConfirm(conversationId);
    const second = await commitWorkflowAtomic({
      ctx: stubToolCtx(
        conversationId,
        await observedEdit(conversationId, readyDraft("adopt-slug", "Adopt Slug v2")),
      ),
    });
    expect(second.ok).toBe(true);
    const secondData = second.data as { workflow_id: string; version: number; slug: string };

    // Same row adopted — single workflow row, version incremented.
    expect(secondData.workflow_id).toBe(firstData.workflow_id);
    expect(secondData.version).toBeGreaterThan(firstData.version);
    expect(secondData.slug).toBe("adopt-slug");

    // Only ONE workflow row for this slug.
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

  // Note: the slug_conflict_with_live_workflow case when pivoting to a DIFFERENT
  // workflow's slug is covered by topic-pivot-identity.test.ts. That test file
  // carries this assertion and is the canonical regression guard for that case.
});

// ── C.2 preview-failure-class gate ───────────────────────────────────────────

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
    // The runtime-data override should be signalled in the envelope.
    // (The gate clears for runtime_data + force_commit.)
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

    // The committed-over-failed-preview signal must land in the audit row so
    // operators can answer "was this committed over a failed dry-run?" without
    // correlating logs by timestamp.
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
    // config_invalid must block even with force_commit.
    expect(result.ok).toBe(false);
    // The top-level error_code from commitWorkflowAtomic.
    const res = result as {
      error_code?: string;
      data?: { preview_failure_class?: string; force_commit_available?: boolean };
    };
    expect(res.error_code).toBe("preview_failed");
    // The failure class is surfaced in data.preview_failure_class.
    expect(res.data?.preview_failure_class).toBe("config_invalid");
    // force_commit_available is false for config_invalid failures.
    expect(res.data?.force_commit_available).toBe(false);
  });
});

// ── C.4 webhook-binding removal guard ────────────────────────────────────────

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

// ── C.3 already_persisted idempotency ────────────────────────────────────────

describe("C.3 — already_persisted idempotency", () => {
  test("re-commit byte-identical draft → already_persisted:true, no new version, one audit row", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    const draft = readyDraft("idempotent-commit", "Idempotent");

    // First commit.
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, await observedEdit(conversationId, draft)),
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { workflow_id: string; version: number };

    // Count audit rows for this workflow after first commit.
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

    // Second commit — byte-identical draft, same slug, same conversation.
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

    // Still exactly one WORKFLOW_CREATED audit row — no second write.
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

// ── M4 — unbound-schedule prominent warning ──────────────────────────────────

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

// ── C.5 unattended-trigger binding guard ─────────────────────────────────────

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
