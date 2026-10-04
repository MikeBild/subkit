import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { auditLog, conversationHidden, conversations, workflows } from "../../db/schema/index.ts";
import { appendMessage } from "../persist.ts";
import {
  appendUserMessage,
  countConversations,
  createConversation,
  getConversation,
  listConversations,
  patchConversation,
  setConversationHidden,
} from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
let workflowId: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("list_view");
  const [wf] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "monthly-report",
      name: "Monthly report",
      lifecycle: "active",
    })
    .returning();
  workflowId = wf!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function listMine(extra: Record<string, unknown> = {}) {
  return listConversations(
    { tenant_id: ctx.tenant_id, owner_id: ctx.user_id, viewer_user_id: ctx.user_id, ...extra },
    ctx.testDb.db,
  );
}

describe("conversation list view", () => {
  test("a row names its owner, surface, target and outcome, and clocks its last activity", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "Explain the monthly report",
        workflow_id: workflowId,
        surface: "web",
        origin_client: "browser_session:session",
      },
      ctx.testDb.db,
    );
    const id = created.conversation.id;
    await appendMessage(ctx.testDb.db, ctx.tenant_id, id, "assistant", {
      text: "It sums revenue.",
    });

    const rows = await listMine();
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.surface).toBe("web");
    expect(row!.origin_client).toBe("browser_session:session");
    expect(row!.owner).toMatchObject({ id: ctx.user_id, kind: "user" });
    expect(row!.owner?.name).toContain("@");
    expect(row!.target_workflow).toEqual({
      id: workflowId,
      slug: "monthly-report",
      name: "Monthly report",
    });
    expect(row!.target_connector).toBeNull();
    expect(row!.message_count).toBe(2);
    expect(row!.last_message_role).toBe("assistant");
    expect(row!.outcome).toBe("answered");
    expect(row!.hidden).toBe(false);
    expect(typeof row!.last_activity_at).toBe("string");
    expect(row!.title_locked).toBe(false);
  });

  test("a conversation whose last row is the person's message is in progress", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "Run it",
        surface: "api",
      },
      ctx.testDb.db,
    );
    const rows = await listMine();
    expect(rows.find((r) => r.id === created.conversation.id)?.outcome).toBe("in_progress");
  });

  test("hide keeps the row for everyone else and out of the caller's list; unhide restores it", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "Old thread",
        surface: "web",
      },
      ctx.testDb.db,
    );
    const id = created.conversation.id;
    const hidden = await setConversationHidden(
      { tenant_id: ctx.tenant_id, conversation_id: id, user_id: ctx.user_id, hidden: true },
      ctx.testDb.db,
    );
    expect(hidden?.id).toBe(id);

    expect((await listMine()).some((r) => r.id === id)).toBe(false);
    expect(
      await countConversations(
        { tenant_id: ctx.tenant_id, owner_id: ctx.user_id, viewer_user_id: ctx.user_id },
        ctx.testDb.db,
      ),
    ).toBe((await listMine()).length);
    const only = await listMine({ hidden: "only" });
    expect(only.map((r) => r.id)).toEqual([id]);
    expect(only[0]?.hidden).toBe(true);
    expect((await listMine({ hidden: "all" })).find((r) => r.id === id)?.hidden).toBe(true);
    expect(
      (
        await listConversations({ tenant_id: ctx.tenant_id, owner_id: ctx.user_id }, ctx.testDb.db)
      ).some((r) => r.id === id),
    ).toBe(true);
    const detail = await getConversation(ctx.tenant_id, id, ctx.testDb.db);
    expect(detail?.conversation.status).toBe("active");

    await setConversationHidden(
      { tenant_id: ctx.tenant_id, conversation_id: id, user_id: ctx.user_id, hidden: false },
      ctx.testDb.db,
    );
    expect((await listMine()).some((r) => r.id === id)).toBe(true);
    const marks = await ctx.testDb.db
      .select()
      .from(conversationHidden)
      .where(
        and(
          eq(conversationHidden.tenant_id, ctx.tenant_id),
          eq(conversationHidden.conversation_id, id),
        ),
      );
    expect(marks).toHaveLength(0);
    const audits = await ctx.testDb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, id)))
      .orderBy(desc(auditLog.ts));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("conversation.hidden");
    expect(actions).toContain("conversation.unhidden");
  });

  test("hiding twice is idempotent and an unknown conversation is null", async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, initial_message: "Twice", surface: "web" },
      ctx.testDb.db,
    );
    const p = {
      tenant_id: ctx.tenant_id,
      conversation_id: created.conversation.id,
      user_id: ctx.user_id,
      hidden: true,
    };
    await setConversationHidden(p, ctx.testDb.db);
    await setConversationHidden(p, ctx.testDb.db);
    expect(
      (await listMine({ hidden: "only" })).filter((r) => r.id === created.conversation.id),
    ).toHaveLength(1);
    expect(
      await setConversationHidden(
        { ...p, conversation_id: "00000000-0000-4000-8000-000000000009" },
        ctx.testDb.db,
      ),
    ).toBeNull();
  });

  test("a title a person sets is locked; a derived title is not", async () => {
    const named = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "x",
        title: "Quarterly close",
        surface: "web",
      },
      ctx.testDb.db,
    );
    expect(named.conversation.title_locked).toBe(true);
    const derived = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "derive me",
        surface: "web",
      },
      ctx.testDb.db,
    );
    expect(derived.conversation.title_locked).toBe(false);
    const patched = await patchConversation(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: derived.conversation.id,
        actor_id: ctx.user_id,
        title: "Renamed by me",
      },
      ctx.testDb.db,
    );
    expect(patched?.title_locked).toBe(true);
    const [row] = await ctx.testDb.db
      .select({ title_locked: conversations.title_locked })
      .from(conversations)
      .where(eq(conversations.id, derived.conversation.id));
    expect(row?.title_locked).toBe(true);
  });

  test("owner_kind=user keeps machine-account conversations out", async () => {
    const machineOwned = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: null,
        initial_message: "verifier ping",
        surface: "api",
      },
      ctx.testDb.db,
    );
    const people = await listConversations(
      { tenant_id: ctx.tenant_id, owner_kind: "user", viewer_user_id: ctx.user_id },
      ctx.testDb.db,
    );
    expect(people.some((r) => r.id === machineOwned.conversation.id)).toBe(false);
    expect(people.every((r) => r.owner?.kind === "user")).toBe(true);
    const all = await listConversations({ tenant_id: ctx.tenant_id }, ctx.testDb.db);
    expect(all.some((r) => r.id === machineOwned.conversation.id)).toBe(true);
  });

  test("append keeps the activity clock moving", async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, initial_message: "first", surface: "web" },
      ctx.testDb.db,
    );
    const before = (await listMine()).find((r) => r.id === created.conversation.id)!
      .last_activity_at!;
    await appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: created.conversation.id,
        actor_id: ctx.user_id,
        message: "second",
      },
      ctx.testDb.db,
    );
    const after = (await listMine()).find((r) => r.id === created.conversation.id)!;
    expect(Date.parse(after.last_activity_at!)).toBeGreaterThanOrEqual(Date.parse(before));
    expect(after.message_count).toBe(2);
  });
});
