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
