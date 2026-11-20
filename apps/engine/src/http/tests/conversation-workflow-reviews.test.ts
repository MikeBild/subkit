import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowInspection,
} from "../../conversations/authoring-state/index.ts";
import { appendSnapshot } from "../../conversations/draft.ts";
import {
  conversationElicitations,
  conversations,
  userSetupPreferences,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

const nextUuid = createDeterministicUuidFactory(314159);

let srv: HttpTestServer;
let conversationId: string;

beforeAll(async () => {
  srv = await createHttpTestServer("conversation-workflow-reviews");
  const [conversation] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  if (!conversation) throw new Error("conversation fixture missing");
  conversationId = conversation.id;
});

afterAll(async () => {
  await srv?.cleanup();
});

const reviewPath = () => `/v1/conversations/${conversationId}/workflow-reviews`;

describe("conversation workflow review HTTP boundary", () => {
  test("API keys cannot read a review receipt", async () => {
    const response = await fetch(`${srv.baseUrl}${reviewPath()}/${nextUuid()}`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("human_confirmation_required");
  });

  test("prepare rejects a browser request without CSRF before any review is created", async () => {
    const headers = await browserSessionHeaders(srv, srv.userId);
    delete headers["x-subkit-csrf"];
    const response = await fetch(`${srv.baseUrl}${reviewPath()}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        elicitation_id: nextUuid(),
        activate: false,
        grant: null,
        schedule: null,
      }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("csrf_rejected");
  });

  test("missing receipts return a bounded not-found error without internal exception details", async () => {
    const headers = await browserSessionHeaders(srv, srv.userId);
    const response = await fetch(`${srv.baseUrl}${reviewPath()}/${nextUuid()}`, { headers });
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("workflow_review_not_found");
    expect(JSON.stringify(body)).not.toContain("stack");
    expect(JSON.stringify(body)).not.toContain("SELECT");
  });
});

test("one reviewed save completes the pending decision without granting runs", async () => {
  const [conversation] = await srv.db
    .insert(conversations)
    .values({
      tenant_id: srv.tenantId,
      owner_id: srv.userId,
      status: "awaiting_input",
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("conversation fixture missing");
  const draft = withLatestPreview(
    withWorkflowInspection({
      ...createEmptyDraftDocument("workflow_authoring"),
      workflow: {
        name: "Reviewed sample",
        slug: "reviewed-sample",
        description: "A sample transformation",
        steps: [{ id: "result", kind: "transform", expression: "return { ok: true };" }],
      },
    }),
    { ok: true, summary: "synthetic held preview" },
  );
  await appendSnapshot(srv.tenantId, conversation.id, draft, srv.db);
  const [elicitation] = await srv.db
    .insert(conversationElicitations)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: conversation.id,
      tool_name: "ask_user_confirm",
      summary: "Save the reviewed draft",
      input: { question: "Save?", commit_intent: { kind: "save_workflow_draft" } },
      status: "pending",
    })
    .returning({ id: conversationElicitations.id });
  if (!elicitation) throw new Error("elicitation fixture missing");
  const headers = await browserSessionHeaders(srv, srv.userId);
  const path = `/v1/conversations/${conversation.id}/workflow-reviews`;
  const preparedResponse = await fetch(`${srv.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      elicitation_id: elicitation.id,
      activate: false,
      grant: null,
      schedule: null,
    }),
  });
  expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(201);
  const prepared = (await preparedResponse.json()) as {
    receipt_id: string;
    snapshot_digest: string;
    status: string;
    result: unknown;
  };
  expect(prepared.status).toBe("pending");
  const otherSessionHeaders = await browserSessionHeaders(srv, srv.userId);
  const otherSession = await fetch(`${srv.baseUrl}${path}/${prepared.receipt_id}`, {
    headers: otherSessionHeaders,
  });
  expect(otherSession.status).toBe(403);
  const before = await srv.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.tenant_id, srv.tenantId));
  expect(before.some((row) => row.id === prepared.receipt_id)).toBe(false);
  const mismatch = await fetch(`${srv.baseUrl}${path}/${prepared.receipt_id}/finalize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expected_snapshot_digest: "0".repeat(64) }),
  });
  expect(mismatch.status).toBe(409);
  await srv.db.execute(
    sql`CREATE FUNCTION subkit.reject_review_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test completion failure'; END; $$`,
  );
  await srv.db.execute(
    sql`CREATE TRIGGER reject_review_completion BEFORE UPDATE OF status ON subkit.workflow_review_receipts FOR EACH ROW WHEN (NEW.status = 'completed') EXECUTE FUNCTION subkit.reject_review_completion()`,
  );
  try {
    const failed = await fetch(`${srv.baseUrl}${path}/${prepared.receipt_id}/finalize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expected_snapshot_digest: prepared.snapshot_digest, save_only: true }),
    });
    expect(failed.status).toBe(500);
    const afterFailure = await srv.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, srv.tenantId), eq(workflows.slug, "reviewed-sample")));
    expect(afterFailure).toHaveLength(0);
    const [pending] = await srv.db
      .select({ status: conversationElicitations.status })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(pending?.status).toBe("pending");
  } finally {
    await srv.db.execute(
      sql`DROP TRIGGER IF EXISTS reject_review_completion ON subkit.workflow_review_receipts`,
    );
    await srv.db.execute(sql`DROP FUNCTION IF EXISTS subkit.reject_review_completion()`);
  }
  const finalizedResponse = await fetch(`${srv.baseUrl}${path}/${prepared.receipt_id}/finalize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expected_snapshot_digest: prepared.snapshot_digest, save_only: true }),
  });
  expect(finalizedResponse.status, await finalizedResponse.clone().text()).toBe(200);
  const finalized = (await finalizedResponse.json()) as {
    status: string;
    result: { workflow_id: string; saved: boolean; activated: boolean; granted: boolean };
  };
  expect(finalized.status).toBe("completed");
  expect(finalized.result).toMatchObject({ saved: true, activated: false, granted: false });
  const [stored] = await srv.db
    .select({ id: workflows.id, lifecycle: workflows.lifecycle })
    .from(workflows)
    .where(
      and(eq(workflows.tenant_id, srv.tenantId), eq(workflows.id, finalized.result.workflow_id)),
    );
  expect(stored?.lifecycle).toBe("draft");
  const [decision] = await srv.db
    .select({ status: conversationElicitations.status })
    .from(conversationElicitations)
    .where(eq(conversationElicitations.id, elicitation.id));
  expect(decision?.status).toBe("resolved");
  const repeated = await fetch(`${srv.baseUrl}${path}/${prepared.receipt_id}/finalize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expected_snapshot_digest: prepared.snapshot_digest, save_only: true }),
  });
  expect(repeated.status).toBe(200);
  expect(((await repeated.json()) as { result: { workflow_id: string } }).result.workflow_id).toBe(
    finalized.result.workflow_id,
  );
});

test("reviewed activation, bounded grant and schedule commit together", async () => {
  const [conversation] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, owner_id: srv.userId, status: "awaiting_input" })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("conversation fixture missing");
  await appendSnapshot(
    srv.tenantId,
    conversation.id,
    withLatestPreview(
      withWorkflowInspection({
        ...createEmptyDraftDocument("workflow_authoring"),
        workflow: {
          name: "Reviewed grant sample",
          slug: "reviewed-grant-sample",
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
  const headers = await browserSessionHeaders(srv, srv.userId);
  const path = `/v1/conversations/${conversation.id}/workflow-reviews`;
  const now = getTestNow();
  const preparedResponse = await fetch(`${srv.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      elicitation_id: elicitation.id,
      activate: true,
      grant: {
        environment: "prod",
        valid_from: new Date(now - 60_000).toISOString(),
        valid_until: new Date(now + 86_400_000).toISOString(),
        max_runs: 3,
      },
      schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    }),
  });
  expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(201);
  const prepared = (await preparedResponse.json()) as {
    receipt_id: string;
    snapshot_digest: string;
  };
  const finalizedResponse = await fetch(`${srv.baseUrl}${path}/${prepared.receipt_id}/finalize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expected_snapshot_digest: prepared.snapshot_digest }),
  });
  expect(finalizedResponse.status, await finalizedResponse.clone().text()).toBe(200);
  const finalized = (await finalizedResponse.json()) as {
    result: {
      workflow_id: string;
      authority_id: string | null;
      schedule_id: string | null;
      activated: boolean;
      granted: boolean;
    };
  };
  expect(finalized.result).toMatchObject({ activated: true, granted: true });
  expect(finalized.result.authority_id).not.toBeNull();
  expect(finalized.result.schedule_id).not.toBeNull();
  const [stored] = await srv.db
    .select({ lifecycle: workflows.lifecycle })
    .from(workflows)
    .where(eq(workflows.id, finalized.result.workflow_id));
  expect(stored?.lifecycle).toBe("active");
  const [schedule] = await srv.db
    .select({ cron: workflowsSchedules.cron, paused: workflowsSchedules.paused })
    .from(workflowsSchedules)
    .where(eq(workflowsSchedules.id, finalized.result.schedule_id ?? ""));
  expect(schedule).toMatchObject({ cron: "0 9 * * 1", paused: false });
});

interface WebhookTrigger {
  kind: "webhook";
  source: string;
  events: string[];
  verify: "none";
}

async function pendingSave(slug: string, trigger?: WebhookTrigger, targetWorkflowId?: string) {
  const [conversation] = await srv.db
    .insert(conversations)
    .values({
      tenant_id: srv.tenantId,
      owner_id: srv.userId,
      status: "awaiting_input",
      ...(targetWorkflowId ? { target_workflow_id: targetWorkflowId } : {}),
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
          ...(trigger ? { trigger } : {}),
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

test("an approval until revoked is granted through the chat review", async () => {
  const review = await pendingSave("reviewed-open-ended-sample");
  const headers = await browserSessionHeaders(srv, srv.userId);
  const body = JSON.stringify({
    elicitation_id: review.elicitation_id,
    activate: true,
    grant: {
      environment: "prod",
      valid_from: new Date(getTestNow() - 60_000).toISOString(),
      valid_until: null,
      max_runs: null,
    },
    schedule: null,
  });
  const preparedResponse = await fetch(`${srv.baseUrl}${review.path}`, {
    method: "POST",
    headers,
    body,
  });
  expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(201);
  const prepared = (await preparedResponse.json()) as PreparedReview;
  expect(prepared.actions.grant).toMatchObject({ valid_until: null, max_runs: null });
  const stale = await fetch(`${srv.baseUrl}${review.path}/${prepared.receipt_id}/finalize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expected_snapshot_digest: "0".repeat(64) }),
  });
  expect(stale.status).toBe(409);
  const { "x-subkit-csrf": _csrf, ...withoutCsrf } = headers;
  const unproven = await fetch(`${srv.baseUrl}${review.path}/${prepared.receipt_id}/finalize`, {
    method: "POST",
    headers: withoutCsrf,
    body: JSON.stringify({ expected_snapshot_digest: prepared.snapshot_digest }),
  });
  expect(unproven.status).toBe(403);
  expect(((await unproven.json()) as { code: string }).code).toBe("csrf_rejected");
  expect(
    await srv.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, srv.tenantId),
          eq(workflows.slug, "reviewed-open-ended-sample"),
        ),
      ),
  ).toHaveLength(0);
  const finalizedResponse = await fetch(
    `${srv.baseUrl}${review.path}/${prepared.receipt_id}/finalize`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ expected_snapshot_digest: prepared.snapshot_digest }),
    },
  );
  expect(finalizedResponse.status, await finalizedResponse.clone().text()).toBe(200);
  const finalized = (await finalizedResponse.json()) as {
    result: { workflow_id: string; authority_id: string | null; granted: boolean };
  };
  expect(finalized.result.granted).toBe(true);
  const [authority] = await srv.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, srv.tenantId),
        eq(workflowExecutionAuthorities.id, finalized.result.authority_id ?? ""),
      ),
    );
  expect(authority).toMatchObject({
    workflow_id: finalized.result.workflow_id,
    execution_environment: "prod",
    valid_until: null,
    max_runs: null,
    revoked_at: null,
  });
});

test("a webhook-triggered draft is suggested as automatic work, not as one manual run", async () => {
  const headers = await browserSessionHeaders(srv, srv.userId);
  const suggestion = async (slug: string, trigger?: WebhookTrigger, targetWorkflowId?: string) => {
    const review = await pendingSave(slug, trigger, targetWorkflowId);
    const response = await fetch(`${srv.baseUrl}${review.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        elicitation_id: review.elicitation_id,
        activate: false,
        grant: null,
        schedule: null,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const grant = ((await response.json()) as PreparedReview).suggested_actions.grant;
    if (!grant?.valid_until) throw new Error("suggested grant missing");
    return {
      days: (Date.parse(grant.valid_until) - Date.parse(grant.valid_from)) / 86_400_000,
      max_runs: grant.max_runs,
    };
  };
  expect(await suggestion("reviewed-manual-sample")).toEqual({ days: 1, max_runs: 1 });
  expect(
    await suggestion("reviewed-webhook-sample", {
      kind: "webhook",
      source: "generic",
      events: [],
      verify: "none",
    }),
  ).toEqual({ days: 30, max_runs: 100 });
  const [saved] = await srv.db
    .insert(workflows)
    .values({
      tenant_id: srv.tenantId,
      name: "Reviewed hooked sample",
      slug: "reviewed-hooked-sample",
      lifecycle: "draft",
    })
    .returning({ id: workflows.id });
  if (!saved) throw new Error("saved workflow fixture missing");
  expect(await suggestion("reviewed-hooked-sample", undefined, saved.id)).toEqual({
    days: 1,
    max_runs: 1,
  });
  await srv.db.insert(webhooksInbound).values({
    tenant_id: srv.tenantId,
    workflow_id: saved.id,
    slug: "reviewed-hooked-sample-hook",
    verifier: "standard",
    secret_ciphertext: Buffer.alloc(1),
    secret_iv: Buffer.alloc(1),
    secret_auth_tag: Buffer.alloc(1),
    active: true,
  });
  const hooked = await suggestion("reviewed-hooked-sample", undefined, saved.id);
  expect(hooked.days).toBe(30);
  expect(hooked.max_runs).toBeGreaterThanOrEqual(100);
});

test("the suggested approval starts in the person's default environment", async () => {
  const headers = await browserSessionHeaders(srv, srv.userId);
  const suggested = async (slug: string) => {
    const review = await pendingSave(slug);
    const response = await fetch(`${srv.baseUrl}${review.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        elicitation_id: review.elicitation_id,
        activate: false,
        grant: null,
        schedule: null,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as {
      suggested_actions: { grant: { environment: string } | null };
    };
    return body.suggested_actions.grant?.environment;
  };
  expect(await suggested("reviewed-default-prod")).toBe("prod");
  await srv.db
    .insert(userSetupPreferences)
    .values({ tenant_id: srv.tenantId, user_id: srv.userId, default_environment: "dev" });
  try {
    expect(await suggested("reviewed-default-dev")).toBe("dev");
  } finally {
    await srv.db.delete(userSetupPreferences).where(eq(userSetupPreferences.user_id, srv.userId));
  }
});
