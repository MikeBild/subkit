import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowInspection,
} from "../../conversations/authoring-state/index.ts";
import { appendSnapshot } from "../../conversations/draft.ts";
import {
  auditLog,
  conversationElicitations,
  conversations,
  tenants,
  users,
  workflowAuthorityPairRequests,
  workflowExecutionAuthorities,
  workflows,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("conversation-workflow-reviews-pair");
});

afterAll(async () => {
  await srv?.cleanup();
});

async function pendingSave(slug: string) {
  const [conversation] = await srv.db
    .insert(conversations)
    .values({
      tenant_id: srv.tenantId,
      owner_id: srv.userId,
      status: "awaiting_input",
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("conversation fixture missing");
  await appendSnapshot(
    srv.tenantId,
    conversation.id,
    withLatestPreview(
      withWorkflowInspection({
        ...createEmptyDraftDocument("workflow_authoring"),
        workflow: {
          name: slug,
          slug,
          steps: [{ id: "result", kind: "transform", expression: "return { ok: true };" }],
        },
      }),
      { ok: true, summary: "synthetic held preview" },
    ),
    srv.db,
  );
  const [elicitation] = await srv.db
    .insert(conversationElicitations)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: conversation.id,
      tool_name: "ask_user_confirm",
      summary: "Save and activate the reviewed draft",
      input: { question: "Save and activate?", commit_intent: { kind: "save_workflow_draft" } },
      status: "pending",
    })
    .returning({ id: conversationElicitations.id });
  if (!elicitation) throw new Error("elicitation fixture missing");
  return {
    path: `/v1/conversations/${conversation.id}/workflow-reviews`,
    elicitation_id: elicitation.id,
  };
}

interface PreparedReview {
  receipt_id: string;
  snapshot_digest: string;
  actions: { grant: { valid_until: string | null; max_runs: number | null } | null };
  suggested_actions: {
    grant: { valid_from: string; valid_until: string | null; max_runs: number | null } | null;
  };
}
test("under pair approval the chat review saves and opens a pair request instead of granting", async () => {
  const headers = await browserSessionHeaders(srv, srv.userId);
  const grant = {
    environment: "prod",
    valid_from: new Date(getTestNow() - 60_000).toISOString(),
    valid_until: new Date(getTestNow() + 86_400_000).toISOString(),
    max_runs: 5,
  };
  const prepare = async (slug: string, schedule: { cron: string; timezone: string } | null) => {
    const review = await pendingSave(slug);
    const response = await fetch(`${srv.baseUrl}${review.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        elicitation_id: review.elicitation_id,
        activate: true,
        grant,
        schedule,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const prepared = (await response.json()) as PreparedReview;
    const receiptPath = `${srv.baseUrl}${review.path}/${prepared.receipt_id}`;
    const finalized = await fetch(`${receiptPath}/finalize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expected_snapshot_digest: prepared.snapshot_digest }),
    });
    return { finalized, receiptPath };
  };
  await srv.db
    .update(tenants)
    .set({ workflow_approval_policy: "pair" })
    .where(eq(tenants.id, srv.tenantId));
  try {
    const { finalized: scheduled } = await prepare("reviewed-pair-scheduled", {
      cron: "0 9 * * 1",
      timezone: "UTC",
    });
    expect(scheduled.status).toBe(422);
    expect(((await scheduled.json()) as { code: string }).code).toBe("pair_schedule_unsupported");
    expect(
      await srv.db
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(eq(workflows.tenant_id, srv.tenantId), eq(workflows.slug, "reviewed-pair-scheduled")),
        ),
    ).toHaveLength(0);

    const { finalized: finalizedResponse, receiptPath } = await prepare(
      "reviewed-pair-sample",
      null,
    );
    expect(finalizedResponse.status, await finalizedResponse.clone().text()).toBe(200);
    const finalized = (await finalizedResponse.json()) as {
      receipt_id: string;
      status: string;
      result: {
        workflow_id: string;
        authority_id: string | null;
        granted: boolean;
        activated: boolean;
        pair_request_id: string | null;
      };
    };
    expect(finalized.status).toBe("completed");
    expect(finalized.result).toMatchObject({
      authority_id: null,
      granted: false,
      activated: false,
    });
    expect(finalized.result.pair_request_id).not.toBeNull();
    expect(
      await srv.db
        .select({ id: workflowExecutionAuthorities.id })
        .from(workflowExecutionAuthorities)
        .where(eq(workflowExecutionAuthorities.workflow_id, finalized.result.workflow_id)),
    ).toHaveLength(0);
    const [request] = await srv.db
      .select()
      .from(workflowAuthorityPairRequests)
      .where(eq(workflowAuthorityPairRequests.id, finalized.result.pair_request_id ?? ""));
    expect(request).toMatchObject({
      workflow_id: finalized.result.workflow_id,
      state: "pending",
      first_approver_id: srv.userId,
      execution_environment: "prod",
    });
    const stored = (request?.grant ?? {}) as { max_runs?: number; activation?: unknown };
    expect(stored.max_runs).toBe(5);
    expect(stored.activation).toBeDefined();
    const audited = await srv.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "workflow.pair_approval_requested"),
          eq(auditLog.resource_id, finalized.result.workflow_id),
        ),
      );
    expect(audited).toHaveLength(1);

    const reread = await fetch(receiptPath, { headers });
    expect(reread.status).toBe(200);
    expect(
      ((await reread.json()) as { result: { pair_request_id: string | null } }).result
        .pair_request_id,
    ).toBe(finalized.result.pair_request_id);

    const [second] = await srv.db
      .insert(users)
      .values({
        tenant_id: srv.tenantId,
        email: "second-approver@reviews.test",
        role_id: await builtinRoleId(srv.db, "admin"),
      })
      .returning({ id: users.id });
    if (!second) throw new Error("second approver fixture missing");
    const approvePath = `${srv.baseUrl}/v1/workflows/${finalized.result.workflow_id}/pair-approvals/${finalized.result.pair_request_id}/approve`;
    const self = await fetch(approvePath, { method: "POST", headers });
    expect(self.status).toBe(403);
    expect(
      await srv.db
        .select({ id: workflowExecutionAuthorities.id })
        .from(workflowExecutionAuthorities)
        .where(eq(workflowExecutionAuthorities.workflow_id, finalized.result.workflow_id)),
    ).toHaveLength(0);

    const approved = await fetch(approvePath, {
      method: "POST",
      headers: await browserSessionHeaders(srv, second.id),
    });
    expect(approved.status, await approved.clone().text()).toBe(201);
    const decision = (await approved.json()) as {
      pair_approval: { state: string; second_approver: { user_id: string } | null };
      authority: { id: string; state: string };
    };
    expect(decision.pair_approval).toMatchObject({
      state: "approved",
      second_approver: { user_id: second.id },
    });
    const authorities = await srv.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(eq(workflowExecutionAuthorities.workflow_id, finalized.result.workflow_id));
    expect(authorities).toHaveLength(1);
    expect(authorities[0]).toMatchObject({
      id: decision.authority.id,
      created_by: second.id,
      max_runs: 5,
      execution_environment: "prod",
    });
    const [closed] = await srv.db
      .select()
      .from(workflowAuthorityPairRequests)
      .where(eq(workflowAuthorityPairRequests.id, finalized.result.pair_request_id ?? ""));
    expect(closed).toMatchObject({
      state: "approved",
      second_approver_id: second.id,
      authority_id: decision.authority.id,
    });
    const [activated] = await srv.db
      .select({ lifecycle: workflows.lifecycle, current: workflows.current_version_id })
      .from(workflows)
      .where(eq(workflows.id, finalized.result.workflow_id));
    expect(activated).toMatchObject({ lifecycle: "active", current: request?.workflow_version_id });
  } finally {
    await srv.db
      .update(tenants)
      .set({ workflow_approval_policy: "single" })
      .where(eq(tenants.id, srv.tenantId));
  }
});
