import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
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
  conversationElicitations,
  conversations,
  conversationTurns,
  users,
} from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedConnector } from "../../test-helpers/seed.ts";
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

  test("held changes of a run can be released only by the owner, an admin is refused like in the answer route", async () => {
    const connector = await seedConnector(srv.db, {
      tenant_id: srv.tenantId,
      slug: "approval-api",
    });
    const admin = await seedUser("approver-admin", "admin");
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
      expect(await decide(admin)).toBe(!marked);
      expect(
        await taskRunApprovalRefusal(srv.db, {
          tenant_id: srv.tenantId,
          approval_id,
          user_id: admin,
        }),
      ).toBe(marked ? "owner_only" : null);
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
