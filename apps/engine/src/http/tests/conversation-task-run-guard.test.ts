import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTaskRunCheck, getTaskRunMarker } from "../../conversations/public/authoring.ts";
import { createConversation } from "../../conversations/service/index.ts";
import {
  conversationMessages,
  conversations,
  fileLinks,
  knowledgeSources,
  users,
} from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c04);

let srv: HttpTestServer;
let memberHeaders: Record<string, string>;
let ownerHeaders: Record<string, string>;
let owner_id: string;
const originalProvider = testEnv.LLM_PROVIDER;

const MARKER = {
  task_id: "44444444-5555-4666-8777-888888888888",
  task_run_id: "55555555-6666-4777-8888-999999999999",
  environment: "prod",
  workflow_ids: [],
  connector_ids: [],
  web_search: true,
};
const SMUGGLED = {
  task_run: MARKER,
  task_check: { at: "2099-01-01T00:00:00Z", reason: "smuggled" },
  session: { task_run: MARKER },
  draft: { session: { task_run: MARKER } },
};

async function seedMember(label: string): Promise<string> {
  const [user] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: `${label}@run-guard.test.local`,
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("member fixture missing");
  return user.id;
}

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("conv-task-run-guard");
  owner_id = await seedMember("owner");
  ownerHeaders = await browserSessionHeaders(srv, owner_id);
  memberHeaders = await browserSessionHeaders(srv, await seedMember("other"));
}, 120_000);

afterAll(async () => {
  if (originalProvider === undefined) delete testEnv.LLM_PROVIDER;
  else testEnv.LLM_PROVIDER = originalProvider;
  await srv.cleanup();
}, 60_000);

function admin(method: string, path: string, body?: unknown): Promise<Response> {
  return call({ authorization: `Bearer ${srv.apiKey}`, "content-type": "application/json" })(
    method,
    path,
    body,
  );
}

function call(headers: Record<string, string>) {
  return (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${srv.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

async function draftOf(conversation_id: string): Promise<unknown> {
  const [row] = await srv.db
    .select({ draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, srv.tenantId), eq(conversations.id, conversation_id)));
  return row?.draft;
}

async function expectUnmarked(conversation_id: string): Promise<void> {
  const draft = await draftOf(conversation_id);
  expect(getTaskRunMarker(draft)).toBeNull();
  expect(getTaskRunCheck(draft)).toBeNull();
}

async function messagesOf(conversation_id: string) {
  return srv.db
    .select({ id: conversationMessages.id, role: conversationMessages.role })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, srv.tenantId),
        eq(conversationMessages.conversation_id, conversation_id),
      ),
    )
    .orderBy(conversationMessages.created_at);
}

async function ordinaryConversation(): Promise<string> {
  const created = await createConversation({ tenant_id: srv.tenantId, actor_id: owner_id }, srv.db);
  return created.conversation.id;
}

async function runConversation(): Promise<string> {
  const created = await createConversation(
    { tenant_id: srv.tenantId, actor_id: owner_id, task_run: { ...MARKER, environment: "dev" } },
    srv.db,
  );
  return created.conversation.id;
}

describe("no request body can set the run marker or a requested check", () => {
  test("creating a conversation", async () => {
    const before = await srv.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.tenant_id, srv.tenantId));
    const res = await admin("POST", "/v1/conversations", SMUGGLED);
    expect(res.status).toBeLessThan(500);
    const after = await srv.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.tenant_id, srv.tenantId));
    const known = new Set(before.map((row) => row.id));
    for (const row of after.filter((candidate) => !known.has(candidate.id)))
      await expectUnmarked(row.id);
  }, 60_000);

  test("sending a message", async () => {
    const conversation_id = await ordinaryConversation();
    getMockProvider().setConversePlan(conversation_id, [{ text: "Hello." }]);
    const res = await call(ownerHeaders)("POST", `/v1/conversations/${conversation_id}/messages`, {
      message: "Hello there.",
      ...SMUGGLED,
    });
    expect(res.status).toBeLessThan(500);
    await res.text();
    await expectUnmarked(conversation_id);
  }, 120_000);

  test("restoring a draft snapshot and patching the draft", async () => {
    const conversation_id = await ordinaryConversation();
    for (const [path, body] of [
      ["draft/snapshots/restore", { snapshot_id: nextUuid(), ...SMUGGLED }],
      [
        "draft/patch",
        {
          ops: [{ op: "add", path: "/session/task_run", value: MARKER }],
          patch: [{ op: "add", path: "/session/task_run", value: MARKER }],
          ...SMUGGLED,
        },
      ],
    ] as const) {
      const res = await call(ownerHeaders)(
        "POST",
        `/v1/conversations/${conversation_id}/${path}`,
        body,
      );
      expect(res.status).toBeLessThan(500);
      await res.text();
      await expectUnmarked(conversation_id);
    }
  }, 60_000);

  test("forking, also from a run conversation", async () => {
    for (const source of [await ordinaryConversation(), await runConversation()]) {
      const [message] = await srv.db
        .insert(conversationMessages)
        .values({
          tenant_id: srv.tenantId,
          conversation_id: source,
          role: "user",
          content: { text: "first" },
        })
        .returning({ id: conversationMessages.id });
      const res = await call(ownerHeaders)(
        "POST",
        `/v1/conversations/${source}/fork-from-message/${message!.id}`,
        SMUGGLED,
      );
      expect(res.status).toBeLessThan(300);
      const body = (await res.json()) as { conversation: { id: string } };
      await expectUnmarked(body.conversation.id);
    }
  }, 60_000);
});

describe("HTTP writes to a run conversation", () => {
  test("another member cannot send a message, the owner and an admin can", async () => {
    const conversation_id = await runConversation();
    const refused = await call(memberHeaders)(
      "POST",
      `/v1/conversations/${conversation_id}/messages`,
      { message: "Do something else." },
    );
    expect([403, 404]).toContain(refused.status);
    await refused.text();
    expect(await messagesOf(conversation_id)).toHaveLength(0);

    getMockProvider().setConversePlan(conversation_id, [{ text: "Carrying on." }]);
    const accepted = await call(ownerHeaders)(
      "POST",
      `/v1/conversations/${conversation_id}/messages`,
      { message: "Carry on." },
    );
    expect(accepted.status).toBe(200);
    await accepted.text();
    getMockProvider().setConversePlan(conversation_id, [{ text: "Looked." }]);
    const asAdmin = await admin("POST", `/v1/conversations/${conversation_id}/messages`, {
      message: "Status?",
    });
    expect(asAdmin.status).toBe(200);
    await asAdmin.text();
    const marker = getTaskRunMarker(await draftOf(conversation_id));
    expect(marker?.environment).toBe("dev");
  }, 180_000);

  test("confirmation settings are locked for everyone", async () => {
    const conversation_id = await runConversation();
    for (const send of [admin, call(ownerHeaders), call(memberHeaders)]) {
      const res = await send("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
        policies: { run_workflow: "confirm_before_execution" },
      });
      expect([403, 404, 409]).toContain(res.status);
      await res.text();
    }
    const locked = await admin("PUT", `/v1/conversations/${conversation_id}/tool-policies`, {
      policies: { run_workflow: "confirm_before_execution" },
    });
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as { code: string }).code).toBe("task_run_locked");
    const [row] = await srv.db
      .select({ tool_policies: conversations.tool_policies })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, srv.tenantId), eq(conversations.id, conversation_id)));
    expect(row?.tool_policies ?? {}).toEqual({});
  }, 60_000);

  test("compacting and direct tools are refused for another member and unavailable for the owner", async () => {
    const conversation_id = await runConversation();
    const compact = await call(memberHeaders)(
      "POST",
      `/v1/conversations/${conversation_id}/compact`,
      {},
    );
    expect([403, 404]).toContain(compact.status);
    await compact.text();
    for (const path of ["preview", "draft/snapshots/restore", "draft/patch", "probe"]) {
      const asMember = await call(memberHeaders)(
        "POST",
        `/v1/conversations/${conversation_id}/${path}`,
        {},
      );
      expect(asMember.status).toBeGreaterThanOrEqual(400);
      expect(asMember.status).toBeLessThan(500);
      await asMember.text();
      const asOwner = await call(ownerHeaders)(
        "POST",
        `/v1/conversations/${conversation_id}/${path}`,
        {},
      );
      expect(asOwner.status).toBeGreaterThanOrEqual(400);
      expect(asOwner.status).toBeLessThan(500);
      await asOwner.text();
    }
    expect(await messagesOf(conversation_id)).toHaveLength(0);
    expect(getTaskRunMarker(await draftOf(conversation_id))).not.toBeNull();
  }, 60_000);
  test("another member cannot upload or attach a file, and reviews are closed", async () => {
    const conversation_id = await runConversation();
    const { "content-type": _json, ...multipart } = memberHeaders;
    const form = new FormData();
    form.set("message", "Use this file.");
    form.append("files", new File(["a,b\n1,2\n"], "numbers.csv", { type: "text/csv" }));
    const upload = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/messages/upload`,
      { method: "POST", headers: multipart, body: form },
    );
    expect([403, 404]).toContain(upload.status);
    await upload.text();
    const inline = {
      filename: "numbers.csv",
      content_type: "text/csv",
      content_base64: Buffer.from("a,b\n1,2\n").toString("base64"),
    };
    const attach = await call(memberHeaders)(
      "POST",
      `/v1/conversations/${conversation_id}/attachments`,
      inline,
    );
    expect([403, 404]).toContain(attach.status);
    await attach.text();
    const links = await srv.db
      .select({ id: fileLinks.id })
      .from(fileLinks)
      .where(
        and(eq(fileLinks.tenant_id, srv.tenantId), eq(fileLinks.resource_id, conversation_id)),
      );
    expect(links).toHaveLength(0);
    const sources = await srv.db
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenant_id, srv.tenantId));
    expect(sources).toHaveLength(0);
    expect(await messagesOf(conversation_id)).toHaveLength(0);

    const asOwner = await call(ownerHeaders)(
      "POST",
      `/v1/conversations/${conversation_id}/attachments`,
      inline,
    );
    expect(asOwner.status).toBe(201);
    await asOwner.text();

    const review = await call(ownerHeaders)(
      "POST",
      `/v1/conversations/${conversation_id}/workflow-reviews`,
      {},
    );
    expect(review.status).toBeGreaterThanOrEqual(400);
    expect(review.status).toBeLessThan(500);
    await review.text();
    const answer = await call(memberHeaders)(
      "POST",
      `/v1/conversations/${conversation_id}/tool-calls/${nextUuid()}/respond`,
      { output: { text: "yes" } },
    );
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(500);
    await answer.text();
  }, 120_000);
});
