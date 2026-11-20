import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import { listElicitationsForConversation } from "../../conversations/elicitations.ts";
import {
  assertTaskRunWriter,
  cancelConversation,
  mayDecideTaskRunApproval,
  setConversationHidden,
  taskRunApprovalRefusal,
} from "../../conversations/public/lifecycle.ts";
import { createConversation } from "../../conversations/service.ts";
import {
  auditLog,
  conversationElicitations,
  conversations,
  conversationTurns,
  toolApprovals,
  users,
} from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedConnector } from "../../test-helpers/seed.ts";
import { mintApprovalGrantUrl } from "../../tools/approval-portal.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c05);

let srv: HttpTestServer;
let owner_id: string;
let other_id: string;
let ownerHeaders: Record<string, string>;
let otherHeaders: Record<string, string>;
const originalProvider = process.env.LLM_PROVIDER;
const originalMasterKey = process.env.MASTER_KEY;
const FORBIDDEN = { code: "task_run_write_forbidden" };
const FAILURE = { code: "internal", message: "kept as it was", at: "2026-01-01T00:00:00.000Z" };

async function seedUser(label: string, role: "admin" | "member", status = "active") {
  const [user] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: `${label}@run-refusal.test.local`,
      role_id: await builtinRoleId(srv.db, role),
      status: status as "active",
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user fixture missing");
  return user.id;
}

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  process.env.MASTER_KEY = originalMasterKey ?? "a".repeat(64);
  resetMockProvider();
  srv = await createHttpTestServer("conv-task-run-refusal");
  await setConfigKey("server.public_base_url", srv.baseUrl, { force: true });
  owner_id = await seedUser("owner", "member");
  other_id = await seedUser("other", "member");
  ownerHeaders = await browserSessionHeaders(srv, owner_id);
  otherHeaders = await browserSessionHeaders(srv, other_id);
}, 120_000);

afterAll(async () => {
  if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = originalProvider;
  if (originalMasterKey === undefined) delete process.env.MASTER_KEY;
  await srv.cleanup();
}, 60_000);

async function runConversation(connector_ids: string[] = []): Promise<string> {
  const created = await createConversation(
    {
      tenant_id: srv.tenantId,
      actor_id: owner_id,
      task_run: {
        task_id: "44444444-5555-4666-8777-888888888888",
        task_run_id: "55555555-6666-4777-8888-999999999999",
        environment: "dev",
        workflow_ids: [],
        connector_ids,
        web_search: false,
      },
    },
    srv.db,
  );
  return created.conversation.id;
}

function post(headers: Record<string, string>, path: string, body: unknown, accept?: string) {
  return fetch(`${srv.baseUrl}${path}`, {
    method: "POST",
    headers: { ...headers, ...(accept ? { accept } : {}) },
    body: JSON.stringify(body),
  });
}

async function state(conversation_id: string) {
  const [row] = await srv.db
    .select({ last_turn_error: conversations.last_turn_error, status: conversations.status })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, srv.tenantId), eq(conversations.id, conversation_id)));
  const turns = await srv.db
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenant_id, srv.tenantId),
        eq(conversationTurns.conversation_id, conversation_id),
      ),
    );
  return { last_turn_error: row?.last_turn_error, status: row?.status, turns: turns.length };
}

describe("a refused write leaves the run conversation untouched", () => {
  test("a refused message reserves no turn and keeps the recorded failure, also over SSE", async () => {
    const conversation_id = await runConversation();
    await srv.db
      .update(conversations)
      .set({ last_turn_error: FAILURE })
      .where(and(eq(conversations.tenant_id, srv.tenantId), eq(conversations.id, conversation_id)));
    const before = await state(conversation_id);
    for (const accept of [undefined, "text/event-stream"]) {
      const res = await post(
        otherHeaders,
        `/v1/conversations/${conversation_id}/messages`,
        { message: "Do something else." },
        accept,
      );
      expect([403, 404]).toContain(res.status);
      await res.text();
      expect(await state(conversation_id)).toEqual(before);
    }
    for (const accept of [undefined, "text/event-stream"]) {
      const res = await post(
        ownerHeaders,
        `/v1/conversations/${conversation_id}/messages`,
        { message: "Just do it.", permission_mode: "yolo" },
        accept,
      );
      expect(res.status).toBe(400);
      await res.text();
      expect(await state(conversation_id)).toEqual(before);
    }
  }, 120_000);

  test("a refused answer reserves no turn on either answer route", async () => {
    const conversation_id = await runConversation();
    getMockProvider().setConversePlan(conversation_id, [
      { tool: "ask_user_text", args: { question: "Which month?" } },
    ]);
    const asked = await post(ownerHeaders, `/v1/conversations/${conversation_id}/messages`, {
      message: "Start.",
    });
    expect(asked.status).toBe(200);
    await asked.text();
    const [pending] = (
      await listElicitationsForConversation(srv.tenantId, conversation_id, srv.db)
    ).filter((row) => row.status === "pending");
    if (!pending) throw new Error("expected a pending question");
    const before = await state(conversation_id);
    for (const path of [
      `elicitations/${pending.id}/respond`,
      `tool-calls/${pending.tool_call_id}/respond`,
    ]) {
      for (const accept of [undefined, "text/event-stream"]) {
        const res = await post(
          otherHeaders,
          `/v1/conversations/${conversation_id}/${path}`,
          { output: { text: "March" } },
          accept,
        );
        expect([403, 404]).toContain(res.status);
        await res.text();
        expect(await state(conversation_id)).toEqual(before);
      }
    }
    const still = await listElicitationsForConversation(srv.tenantId, conversation_id, srv.db);
    expect(still.find((row) => row.id === pending.id)?.status).toBe("pending");
  }, 180_000);
});

describe("who may cancel, hide or approve in a run conversation", () => {
  test("cancelling and hiding need the owner or an admin; the system path still cancels", async () => {
    const conversation_id = await runConversation();
    await expect(
      cancelConversation(srv.tenantId, conversation_id, other_id, srv.db, "user"),
    ).rejects.toMatchObject(FORBIDDEN);
    await expect(
      cancelConversation(srv.tenantId, conversation_id, other_id, srv.db, "system"),
    ).rejects.toMatchObject(FORBIDDEN);
    await expect(
      setConversationHidden(
        { tenant_id: srv.tenantId, conversation_id, user_id: other_id, hidden: true },
        srv.db,
      ),
    ).rejects.toMatchObject(FORBIDDEN);
    const viaHttp = await post(otherHeaders, `/v1/conversations/${conversation_id}/cancel`, {});
    expect(viaHttp.status).toBeGreaterThanOrEqual(400);
    await viaHttp.text();
    expect((await state(conversation_id)).status).toBe("active");
    await setConversationHidden(
      { tenant_id: srv.tenantId, conversation_id, user_id: owner_id, hidden: true },
      srv.db,
    );
    await expect(
      cancelConversation(srv.tenantId, conversation_id, null, srv.db),
    ).rejects.toMatchObject(FORBIDDEN);
    await expect(
      cancelConversation(srv.tenantId, conversation_id, null, srv.db, "system", {
        provider: "session",
        kind: "user",
        id: other_id,
        tenant_id: srv.tenantId,
        roles: ["member"],
      }),
    ).rejects.toMatchObject(FORBIDDEN);
    const bySystem = await cancelConversation(
      srv.tenantId,
      conversation_id,
      null,
      srv.db,
      "system",
    );
    expect(bySystem?.status).toBe("abandoned");
    const second = await runConversation();
    const byOwner = await cancelConversation(srv.tenantId, second, owner_id, srv.db, "user");
    expect(byOwner?.status).toBe("abandoned");
  }, 60_000);

  test("an admin who is no longer active does not count as an admin", async () => {
    const conversation_id = await runConversation();
    const disabled = await seedUser("disabled-admin", "admin", "disabled");
    const active = await seedUser("active-admin", "admin");
    await expect(
      assertTaskRunWriter(srv.db, { tenant_id: srv.tenantId, conversation_id, actor_id: disabled }),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(
      await assertTaskRunWriter(srv.db, {
        tenant_id: srv.tenantId,
        conversation_id,
        actor_id: active,
      }),
    ).not.toBeNull();
  }, 60_000);

  test("held changes of a run can be released by the owner or an admin, nobody else", async () => {
    const connector = await seedConnector(srv.db, {
      tenant_id: srv.tenantId,
      slug: "approval-api",
    });
    const admin = await seedUser("approver-admin", "admin");
    const inactiveAdmin = await seedUser("approver-admin-gone", "admin", "disabled");
    for (const marked of [true, false]) {
      const conversation_id = marked
        ? await runConversation([connector.id])
        : (await createConversation({ tenant_id: srv.tenantId, actor_id: owner_id }, srv.db))
            .conversation.id;
      getMockProvider().setConversePlan(conversation_id, [
        {
          tool: "call_connector",
          args: { connector_id: connector.id, method: "POST", path: "/things", body: {} },
        },
      ]);
      const asked = await post(ownerHeaders, `/v1/conversations/${conversation_id}/messages`, {
        message: "Send it.",
      });
      await asked.text();
      const [pending] = (
        await listElicitationsForConversation(srv.tenantId, conversation_id, srv.db)
      ).filter((row) => row.status === "pending");
      const approval_id = (
        pending?.input as { commit_intent?: { payload?: { approval_id?: string } } } | undefined
      )?.commit_intent?.payload?.approval_id;
      if (!approval_id) throw new Error("expected an approval-backed question");
      const decide = (user_id: string | null) =>
        mayDecideTaskRunApproval(srv.db, { tenant_id: srv.tenantId, approval_id, user_id });
      expect(await decide(other_id)).toBe(!marked);
      expect(await decide(null)).toBe(!marked);
      expect(await decide(owner_id)).toBe(true);
      expect(await decide(admin)).toBe(true);
      expect(await decide(inactiveAdmin)).toBe(!marked);
      for (const user_id of [other_id, inactiveAdmin, null])
        expect(
          await taskRunApprovalRefusal(srv.db, { tenant_id: srv.tenantId, approval_id, user_id }),
        ).toBe(marked ? "owner_or_admin" : null);
      if (!pending) throw new Error("expected a pending question");
      await srv.db
        .update(conversationElicitations)
        .set({ input: { question: "unlinked" } })
        .where(
          and(
            eq(conversationElicitations.tenant_id, srv.tenantId),
            eq(conversationElicitations.id, pending.id),
          ),
        );
      expect(await decide(other_id)).toBe(false);
      expect(await decide(null)).toBe(false);
      expect(await decide(owner_id)).toBe(true);
      expect(await decide(admin)).toBe(true);
    }
    expect(
      await mayDecideTaskRunApproval(srv.db, {
        tenant_id: srv.tenantId,
        approval_id: nextUuid(),
        user_id: owner_id,
      }),
    ).toBe(false);
  }, 180_000);
});

describe("an admin decides the held changes of someone else's run over HTTP", () => {
  let sequence = 0;

  async function held() {
    const connector = await seedConnector(srv.db, {
      tenant_id: srv.tenantId,
      slug: `held-api-${++sequence}`,
    });
    const conversation_id = await runConversation([connector.id]);
    getMockProvider().setConversePlan(conversation_id, [
      {
        tool: "call_connector",
        args: { connector_id: connector.id, method: "POST", path: "/things", body: {} },
      },
    ]);
    const asked = await post(ownerHeaders, `/v1/conversations/${conversation_id}/messages`, {
      message: "Send it.",
    });
    await asked.text();
    const [pending] = (
      await listElicitationsForConversation(srv.tenantId, conversation_id, srv.db)
    ).filter((row) => row.status === "pending");
    const approval_id = (
      pending?.input as { commit_intent?: { payload?: { approval_id?: string } } } | undefined
    )?.commit_intent?.payload?.approval_id;
    if (!pending || !approval_id) throw new Error("expected an approval-backed question");
    getMockProvider().setConversePlan(conversation_id, [{ text: "Sent." }]);
    return { conversation_id, elicitation_id: pending.id, approval_id };
  }

  async function approval(approval_id: string) {
    const [row] = await srv.db
      .select()
      .from(toolApprovals)
      .where(and(eq(toolApprovals.tenant_id, srv.tenantId), eq(toolApprovals.id, approval_id)));
    if (!row) throw new Error("missing approval");
    return row;
  }

  async function actorOf(approval_id: string, action: string) {
    const [entry] = await srv.db
      .select({ actor_id: auditLog.actor_id, result: auditLog.result })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.resource_id, approval_id),
          eq(auditLog.action, action),
        ),
      );
    return entry ?? null;
  }

  async function portal(approval_id: string, cookie: string) {
    const minted = await mintApprovalGrantUrl({
      db: srv.db,
      approval: { id: approval_id, tenant_id: srv.tenantId },
    });
    if (!minted.ok) throw new Error(minted.error);
    const grant = new URL(minted.url).searchParams.get("grant") ?? "";
    const headers = { cookie, "accept-language": "en" };
    const page = await fetch(minted.url, { headers });
    const html = await page.text();
    const csrf_token = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const submit = async (decision: "approve" | "decline") => {
      const res = await fetch(`${srv.baseUrl}/v1/tool-approvals/decide`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant, decision, csrf_token }).toString(),
      });
      return await res.text();
    };
    return { html, csrf_token, submit };
  }

  test("the answer route releases them for an admin, refuses a member and records who decided", async () => {
    const admin = await seedUser("answer-admin", "admin");
    const adminHeaders = await browserSessionHeaders(srv, admin);
    const approved = await held();
    const path = `/v1/conversations/${approved.conversation_id}/elicitations/${approved.elicitation_id}/respond`;
    const refused = await post(otherHeaders, path, { output: { confirmed: true } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject(FORBIDDEN);
    expect((await approval(approved.approval_id)).granted_at).toBeNull();

    const released = await post(adminHeaders, path, { output: { confirmed: true } });
    expect(released.status).toBe(200);
    await released.text();
    const granted = await approval(approved.approval_id);
    expect(granted.granted_by_user_id).toBe(admin);
    expect(granted.granted_via).toBe("chat");
    expect(granted.consumed_at).not.toBeNull();
    expect(granted.principal_id).toBe(owner_id);
    expect(await actorOf(approved.approval_id, "approval.granted")).toEqual({
      actor_id: admin,
      result: "success",
    });
    expect(await actorOf(approved.approval_id, "approval.approved")).toEqual({
      actor_id: owner_id,
      result: "success",
    });

    const declined = await held();
    const no = await post(
      adminHeaders,
      `/v1/conversations/${declined.conversation_id}/elicitations/${declined.elicitation_id}/respond`,
      { output: { confirmed: false } },
    );
    expect(no.status).toBe(200);
    await no.text();
    const dead = await approval(declined.approval_id);
    expect(dead.declined_at).not.toBeNull();
    expect(dead.consumed_at).toBeNull();
    expect(await actorOf(declined.approval_id, "approval.declined")).toEqual({
      actor_id: admin,
      result: "success",
    });
    expect(await actorOf(declined.approval_id, "approval.approved")).toBeNull();
  }, 240_000);

  test("the approval portal shows the decision to an admin and refuses a member on GET and POST", async () => {
    const admin = await seedUser("portal-admin", "admin");
    const adminCookie = (await browserSessionHeaders(srv, admin)).cookie as string;
    const sentence = "Only the owner of the task or an admin can give this approval.";

    const first = await held();
    const stranger = await portal(first.approval_id, otherHeaders.cookie as string);
    expect(stranger.html).toContain(sentence);
    expect(stranger.csrf_token).toBe("");
    const allowed = await portal(first.approval_id, adminCookie);
    expect(allowed.html).not.toContain(sentence);
    expect(allowed.csrf_token).not.toBe("");
    const demoted = await seedUser("portal-demoted", "admin");
    const untouched = await held();
    const opened = await portal(
      untouched.approval_id,
      (await browserSessionHeaders(srv, demoted)).cookie as string,
    );
    expect(opened.csrf_token).not.toBe("");
    await srv.db
      .update(users)
      .set({ role_id: await builtinRoleId(srv.db, "member") })
      .where(and(eq(users.tenant_id, srv.tenantId), eq(users.id, demoted)));
    for (const decision of ["approve", "decline"] as const)
      expect(await opened.submit(decision)).toContain(sentence);
    expect((await approval(untouched.approval_id)).granted_at).toBeNull();
    expect((await approval(untouched.approval_id)).declined_at).toBeNull();

    await allowed.submit("approve");
    const granted = await approval(first.approval_id);
    expect(granted.granted_by_user_id).toBe(admin);
    expect(granted.granted_via).toBe("portal");
    expect(await actorOf(first.approval_id, "approval.granted")).toEqual({
      actor_id: admin,
      result: "success",
    });

    const second = await held();
    await (await portal(second.approval_id, adminCookie)).submit("decline");
    expect((await approval(second.approval_id)).declined_at).not.toBeNull();
    expect(await actorOf(second.approval_id, "approval.declined")).toEqual({
      actor_id: admin,
      result: "success",
    });
  }, 240_000);
});
