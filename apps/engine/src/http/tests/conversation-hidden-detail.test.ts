import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  apiKeys,
  auditLog,
  conversationHidden,
  conversations,
  systemAccounts,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("conv-hidden-detail");
});

afterAll(async () => {
  await srv.cleanup();
});

function call(method: string, path: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
}

async function hiddenInDetail(id: string): Promise<unknown> {
  const res = await call("GET", `/v1/conversations/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { conversation: { hidden?: unknown } }).conversation.hidden;
}

describe("GET /v1/conversations/:id · hidden", () => {
  test("the detail says whether the viewer hid the conversation, so it can be shown again", async () => {
    const [row] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, status: "active", owner_id: srv.userId })
      .returning({ id: conversations.id });
    if (!row) throw new Error("seed conversation failed");

    expect(await hiddenInDetail(row.id)).toBe(false);
    expect((await call("POST", `/v1/conversations/${row.id}/hide`)).status).toBe(200);
    expect(await hiddenInDetail(row.id)).toBe(true);
    expect((await call("POST", `/v1/conversations/${row.id}/unhide`)).status).toBe(200);
    expect(await hiddenInDetail(row.id)).toBe(false);
    const [audit] = await srv.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.resource_id, row.id),
          eq(auditLog.action, "conversation.unhidden"),
        ),
      );
    expect(audit).toEqual({ actor_type: "user", actor_id: srv.userId });
  });

  test("system-account credentials cannot create user-list visibility records", async () => {
    const [row] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, status: "active", owner_id: srv.userId })
      .returning({ id: conversations.id });
    if (!row) throw new Error("seed conversation failed");

    await srv.db
      .update(systemAccounts)
      .set({ role_id: await builtinRoleId(srv.db, "admin") })
      .where(eq(systemAccounts.id, srv.systemAccountId));
    const token = "wf_live_hide_system_account_test_key";
    await srv.db.insert(apiKeys).values({
      tenant_id: srv.tenantId,
      system_account_id: srv.systemAccountId,
      prefix: token.slice(0, 12),
      token_sha256: createHash("sha256").update(token).digest("hex"),
      scopes: ["*"],
    });

    const response = await fetch(`${srv.baseUrl}/v1/conversations/${row.id}/hide`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
    const hiddenRows = await srv.db
      .select()
      .from(conversationHidden)
      .where(
        and(
          eq(conversationHidden.tenant_id, srv.tenantId),
          eq(conversationHidden.conversation_id, row.id),
        ),
      );
    expect(hiddenRows).toHaveLength(0);
  });
});

describe("GET /v1/conversations · task runs", () => {
  test("run conversations are listed only when the query asks for them", async () => {
    const [chat, run] = await srv.db
      .insert(conversations)
      .values([
        { tenant_id: srv.tenantId, status: "active", owner_id: srv.userId, title: "Plain chat" },
        {
          tenant_id: srv.tenantId,
          status: "active",
          owner_id: srv.userId,
          title: "Task run",
          title_locked: true,
          draft: {
            session: {
              task_run: {
                task_id: "44444444-5555-4666-8777-888888888888",
                task_run_id: "55555555-6666-4777-8888-999999999999",
                environment: "prod",
                workflow_ids: [],
                connector_ids: [],
                web_search: false,
              },
            },
          },
        },
      ])
      .returning({ id: conversations.id });
    if (!chat || !run) throw new Error("seed conversations failed");
    const listed = async (query: string) => {
      const res = await call("GET", `/v1/conversations?limit=200${query}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string }[]; total: number };
      return { ids: body.items.map((item) => item.id), total: body.total };
    };
    const standard = await listed("");
    expect(standard.ids).toContain(chat.id);
    expect(standard.ids).not.toContain(run.id);
    const only = await listed("&task_runs=only");
    expect(only).toEqual({ ids: [run.id], total: 1 });
    const all = await listed("&task_runs=all");
    expect(all.ids).toEqual(expect.arrayContaining([chat.id, run.id]));
    expect(all.total).toBe(standard.total + 1);
    expect((await call("GET", "/v1/conversations?task_runs=some")).status).toBe(400);
  });
});
