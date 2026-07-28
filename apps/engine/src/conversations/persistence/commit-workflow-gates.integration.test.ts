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
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
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
    // biome-ignore lint/suspicious/noExplicitAny: minimal engineClient stub
    engineClient: {} as any,
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
    },
  };
}

// ── C.1 same-slug adoption ────────────────────────────────────────────────────

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
        readyDraft("adopt-slug", "Adopt Slug v2"), // same slug, different name
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

describe("C.4 — webhook-binding removal guard", () => {
  const WEBHOOK_TRIGGER = {
    kind: "webhook" as const,
    source: "stripe",
    events: [] as string[],
    verify: "stripe-signature" as const,
  };

  function webhookReadyDraft(slug: string, name = slug): DraftDocument {
    const base = readyDraft(slug, name);
    return { ...base, workflow: { ...base.workflow, trigger: { ...WEBHOOK_TRIGGER } } };
  }

  test("save that drops a webhook trigger is BLOCKED and the inbound hook survives", async () => {
    const conversationId = await freshConversation();

    // First commit: webhook-triggered workflow → reverse-binds a public
    // inbound hook.
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, webhookReadyDraft("wh-guard-block", "WH Guard Block")),
      skipPriorApprovalCheck: true,
      // Standing up a public webhook needs a human decision behind the commit
      // (the unattended-trigger guard). This is fixture setup, not the case
      // under test, so it says so explicitly instead of seeding an approval.
      forceCommit: true,
    });
    expect(first.ok).toBe(true);
    const workflowId = (first.data as { workflow_id: string }).workflow_id;

    const boundBefore = await ctx.testDb.db
      .select({ id: webhooksInbound.id })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, ctx.tenant_id),
          eq(webhooksInbound.workflow_id, workflowId),
        ),
      );
    expect(boundBefore).toHaveLength(1);

    // Second commit (same conversation → same target row): the regenerated
    // draft dropped the trigger (→ implicit request). The guard must block.
    const blocked = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("wh-guard-block", "WH Guard Block")),
      skipPriorApprovalCheck: true,
    });
    expect(blocked.ok).toBe(false);
    const res = blocked as {
      error_code?: string;
      data?: { error_code?: string; new_trigger_kind?: string; force_commit_available?: boolean };
    };
    expect(res.error_code).toBe("webhook_trigger_removal_unconfirmed");
    expect(res.data?.new_trigger_kind).toBe("request");
    expect(res.data?.force_commit_available).toBe(true);

    // The live inbound hook is untouched — the block prevented the teardown.
    const boundAfter = await ctx.testDb.db
      .select({ id: webhooksInbound.id })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, ctx.tenant_id),
          eq(webhooksInbound.workflow_id, workflowId),
        ),
      );
    expect(boundAfter).toHaveLength(1);
  });

  test("force_commit:true lets the operator intentionally remove the webhook binding", async () => {
    const conversationId = await freshConversation();

    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, webhookReadyDraft("wh-guard-force", "WH Guard Force")),
      skipPriorApprovalCheck: true,
      // Standing up a public webhook needs a human decision behind the commit
      // (the unattended-trigger guard). This is fixture setup, not the case
      // under test, so it says so explicitly instead of seeding an approval.
      forceCommit: true,
    });
    expect(first.ok).toBe(true);
    const workflowId = (first.data as { workflow_id: string }).workflow_id;

    const forced = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("wh-guard-force", "WH Guard Force")),
      skipPriorApprovalCheck: true,
      forceCommit: true,
    });
    expect(forced.ok).toBe(true);

    // With the trigger now `request`, the reverse-bind teardown ran — the
    // inbound hook is gone (the operator confirmed this via force_commit).
    const boundAfter = await ctx.testDb.db
      .select({ id: webhooksInbound.id })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, ctx.tenant_id),
          eq(webhooksInbound.workflow_id, workflowId),
        ),
      );
    expect(boundAfter).toHaveLength(0);
  });
});

// ── C.3 already_persisted idempotency ────────────────────────────────────────

describe("C.3 — already_persisted idempotency", () => {
  test("re-commit byte-identical draft → already_persisted:true, no new version, one audit row", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    const draft = readyDraft("idempotent-commit", "Idempotent");

    // First commit.
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, draft),
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
      ctx: stubToolCtx(conversationId, draft),
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

describe("C.5 — unattended-trigger binding guard", () => {
  const SCHEDULE_TRIGGER = {
    kind: "schedule" as const,
    cron: "0 7 * * *",
    tz: "Europe/Berlin",
  };

  function scheduledDraft(slug: string, name = slug): DraftDocument {
    const base = readyDraft(slug, name);
    return { ...base, workflow: { ...base.workflow, trigger: { ...SCHEDULE_TRIGGER } } };
  }

  test("a commit nobody approved does NOT get to start a live cron", async () => {
    // This is the green-dry-run auto-commit shape: `skipPriorApprovalCheck`
    // with no approval row behind it. Binding here would create an unpaused,
    // prod-mode schedule that dispatches real writes with no human in the loop.
    const conversationId = await freshConversation();
    const blocked = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, scheduledDraft("sched-guard-block", "Sched Guard Block")),
      skipPriorApprovalCheck: true,
    });

    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected the guard to block");
    expect(blocked.error_code).toBe("trigger_binding_unconfirmed");
    const data = blocked.data as Record<string, unknown>;
    expect(data.trigger_kind).toBe("schedule");
    expect(data.cron).toBe("0 7 * * *");
    expect(data.force_commit_available).toBe(true);

    // Nothing was written: no workflow, and therefore no schedule.
    const wfRows = await ctx.testDb.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.slug, "sched-guard-block")));
    expect(wfRows).toHaveLength(0);
  });

  test("force_commit binds the schedule — live, unpaused, in prod", async () => {
    const conversationId = await freshConversation();
    const committed = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, scheduledDraft("sched-guard-force", "Sched Guard Force")),
      skipPriorApprovalCheck: true,
      forceCommit: true,
    });
    expect(committed.ok).toBe(true);

    const workflowId = (committed.data as { workflow_id: string }).workflow_id;
    const schedules = await ctx.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, ctx.tenant_id),
          eq(workflowsSchedules.workflow_id, workflowId),
        ),
      );
    expect(schedules).toHaveLength(1);
    // Pinning what the guard exists for: this is what "bound" means.
    expect(schedules[0]?.paused).toBe(false);
    expect(schedules[0]?.execution_mode).toBe("prod");
  });

  test("a step-only edit on an already-bound schedule does not re-ask", async () => {
    // Re-asking on every edit would train the operator to click through the
    // gate. The trigger block is unchanged here, so nothing new is bound.
    const conversationId = await freshConversation();
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, scheduledDraft("sched-guard-edit", "Sched Guard Edit")),
      skipPriorApprovalCheck: true,
      forceCommit: true,
    });
    expect(first.ok).toBe(true);

    const edited = scheduledDraft("sched-guard-edit", "Sched Guard Edit Renamed");
    const second = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, edited),
      skipPriorApprovalCheck: true,
    });
    expect(second.ok).toBe(true);
  });

  test("a request-triggered workflow is never gated — nothing starts by itself", async () => {
    const conversationId = await freshConversation();
    const committed = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("sched-guard-manual", "Sched Guard Manual")),
      skipPriorApprovalCheck: true,
    });
    expect(committed.ok).toBe(true);
  });
});
