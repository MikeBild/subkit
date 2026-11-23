import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations, userSetupPreferences } from "../../db/schema/index.ts";
import type { NoteProposal } from "../core/apply-proposals.ts";
import { learnPersonalNotes } from "../learn.ts";
import { readNotesLearning } from "../persistence/learning-state.ts";
import { enqueueLearningForTenant } from "../scheduled/learn-sweep.ts";
import { listNotes } from "../service.ts";
import { rememberForMeTool } from "../tools.ts";
import type { ProposeNotesInput } from "../writer.ts";
import {
  AT,
  addConversation,
  addMessage,
  ownerOf,
  principalOf,
  setupNotesSuite,
} from "./notes-suite.ts";

const suite = setupNotesSuite("notes-learning");

describe("learning from the person's own messages", () => {
  const seen: ProposeNotesInput[] = [];
  let typed: string;
  let lastAt: Date;

  function propose(proposals: (input: ProposeNotesInput) => NoteProposal[]) {
    return async (input: ProposeNotesInput) => {
      seen.push(input);
      return proposals(input);
    };
  }

  test("the writer sees only what the person typed, and the watermark advances", async () => {
    const mine = await addConversation(suite, suite.memberId);
    const theirs = await addConversation(suite, suite.ctx.userId);
    lastAt = new Date("2026-11-21T10:00:05.123Z");
    typed = await addMessage(
      suite,
      mine,
      "user",
      { text: "Please remember that I work Mondays to Thursdays." },
      new Date("2026-11-21T10:00:00.000Z"),
    );
    await addMessage(
      suite,
      mine,
      "assistant",
      { text: "Noted. You like long reports." },
      new Date("2026-11-21T10:00:01.000Z"),
    );
    await addMessage(
      suite,
      mine,
      "user",
      {
        text: "Continue the task: the customer likes long reports.",
        origin: "task_run_continuation",
      },
      new Date("2026-11-21T10:00:02.000Z"),
    );
    const foreign = await addMessage(
      suite,
      theirs,
      "user",
      { text: "I always fly business class." },
      new Date("2026-11-21T10:00:03.000Z"),
    );
    const [taskChat] = await suite.ctx.db
      .insert(conversations)
      .values({
        tenant_id: suite.ctx.tenantId,
        status: "active",
        owner_id: suite.memberId,
        draft: { session: { task_run: { task_run_id: crypto.randomUUID() } } },
      })
      .returning({ id: conversations.id });
    if (!taskChat) throw new Error("missing task conversation fixture");
    await addMessage(
      suite,
      taskChat.id,
      "user",
      { text: "In this task I always want the long report." },
      new Date("2026-11-21T10:00:04.000Z"),
    );
    await addMessage(suite, mine, "user", { text: "Thanks, that is all for today." }, lastAt);

    seen.length = 0;
    const result = await learnPersonalNotes(
      suite.ctx.db,
      { tenant_id: suite.ctx.tenantId, user_id: suite.memberId },
      {
        now: AT,
        propose: propose(() => [
          {
            area: "routines",
            slug: "working-days",
            origin: "stated",
            fact_kind: "fact",
            text: "Works Mondays to Thursdays.",
            abstract: "Works Mon to Thu",
            quote: "I work Mondays to Thursdays",
            message_id: typed,
          },
          {
            area: "preferences",
            slug: "flights",
            origin: "stated",
            fact_kind: "preference",
            text: "Flies business class.",
            abstract: "Business class",
            quote: "I always fly business class",
            message_id: foreign,
          },
          {
            area: "preferences",
            slug: "reports",
            origin: "inferred",
            fact_kind: "preference",
            text: "Likes long reports.",
            abstract: "Long reports",
            quote: "You like long reports",
            message_id: typed,
          },
        ]),
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages.map((message) => message.text)).toEqual([
      "Please remember that I work Mondays to Thursdays.",
      "Thanks, that is all for today.",
    ]);
    expect(result).toMatchObject({ outcome: "learned", messages: 2, applied: 1, skipped: 0 });
    expect(result.rejected).toEqual([
      { index: 1, reason: "message_not_own" },
      { index: 2, reason: "quote_not_in_own_words" },
    ]);
    const notes = await listNotes(suite.ctx.db, ownerOf(suite, suite.memberId));
    expect(notes.map((note) => note.text)).toEqual(["Works Mondays to Thursdays."]);
    expect(notes[0]?.status).toBe("mentioned_once");
    expect(await listNotes(suite.ctx.db, ownerOf(suite, suite.ctx.userId))).toEqual([]);
    const learning = await readNotesLearning(suite.ctx.db, ownerOf(suite, suite.memberId));
    expect(learning.learned_through?.toISOString()).toBe(lastAt.toISOString());
  });

  test("a second pass has nothing new and does not call the writer", async () => {
    seen.length = 0;
    const result = await learnPersonalNotes(
      suite.ctx.db,
      { tenant_id: suite.ctx.tenantId, user_id: suite.memberId },
      { now: AT, propose: propose(() => []) },
    );
    expect(result.outcome).toBe("nothing_new");
    expect(seen).toEqual([]);
  });

  test("an explicit request reads the latest message of that conversation and confirms the note", async () => {
    const chat = await addConversation(suite, suite.memberId);
    const said = await addMessage(
      suite,
      chat,
      "user",
      { text: "Remember for me: I send invoices every Friday." },
      new Date("2026-11-22T09:00:00.000Z"),
    );
    seen.length = 0;
    const before = await readNotesLearning(suite.ctx.db, ownerOf(suite, suite.memberId));
    const result = await learnPersonalNotes(
      suite.ctx.db,
      {
        tenant_id: suite.ctx.tenantId,
        user_id: suite.memberId,
        explicit: { conversation_id: chat, message_hint: "invoice day" },
      },
      {
        now: AT,
        propose: propose(() => [
          {
            area: "routines",
            slug: "invoice-day",
            origin: "stated",
            fact_kind: "fact",
            text: "Sends invoices every Friday.",
            abstract: "Invoices on Friday",
            quote: "I send invoices every Friday",
            message_id: said,
          },
        ]),
      },
    );
    expect(seen[0]?.hint).toBe("invoice day");
    expect(seen[0]?.messages).toEqual([
      { id: said, text: "Remember for me: I send invoices every Friday." },
    ]);
    expect(result.applied).toBe(1);
    const notes = await listNotes(suite.ctx.db, ownerOf(suite, suite.memberId), {
      status: "confirmed",
    });
    expect(notes.map((note) => note.slug)).toEqual(["invoice-day"]);
    expect(
      (await readNotesLearning(suite.ctx.db, ownerOf(suite, suite.memberId))).learned_through,
    ).toEqual(before.learned_through);
    const other = await learnPersonalNotes(
      suite.ctx.db,
      {
        tenant_id: suite.ctx.tenantId,
        user_id: suite.ctx.userId,
        explicit: { conversation_id: chat, message_hint: "invoice day" },
      },
      { now: AT, propose: propose(() => []) },
    );
    expect(other.outcome).toBe("nothing_new");
  });

  test("the sweep enqueues people with new messages, and the switch stops learning", async () => {
    const jobs: Array<{ tenant_id: string; user_id: string }> = [];
    const collect = async (job: { tenant_id: string; user_id: string }) => {
      jobs.push(job);
    };
    await enqueueLearningForTenant(suite.ctx.db, suite.ctx.tenantId, collect);
    expect(jobs.map((job) => job.user_id).sort()).toEqual(
      [suite.ctx.userId, suite.memberId].sort(),
    );

    const off = await fetch(`${suite.ctx.baseUrl}/v1/identity/me/setup`, {
      method: "PUT",
      headers: suite.memberHeaders,
      body: JSON.stringify({ save_new_notes: false }),
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { save_new_notes: boolean }).save_new_notes).toBe(false);
    const [prefs] = await suite.ctx.db
      .select({ save: userSetupPreferences.save_new_notes })
      .from(userSetupPreferences)
      .where(
        and(
          eq(userSetupPreferences.tenant_id, suite.ctx.tenantId),
          eq(userSetupPreferences.user_id, suite.memberId),
        ),
      );
    expect(prefs?.save).toBe(false);

    jobs.length = 0;
    await enqueueLearningForTenant(suite.ctx.db, suite.ctx.tenantId, collect);
    expect(jobs.map((job) => job.user_id)).toEqual([suite.ctx.userId]);

    seen.length = 0;
    const count = (await listNotes(suite.ctx.db, ownerOf(suite, suite.memberId))).length;
    for (const explicit of [
      undefined,
      { conversation_id: suite.conversationId, message_hint: "x" },
    ]) {
      const result = await learnPersonalNotes(
        suite.ctx.db,
        {
          tenant_id: suite.ctx.tenantId,
          user_id: suite.memberId,
          ...(explicit ? { explicit } : {}),
        },
        { now: AT, propose: propose(() => []) },
      );
      expect(result.outcome).toBe("switched_off");
    }
    expect(seen).toEqual([]);
    expect(await listNotes(suite.ctx.db, ownerOf(suite, suite.memberId))).toHaveLength(count);
    const tool = await rememberForMeTool.execute(
      {
        db: suite.ctx.db,
        tenant_id: suite.ctx.tenantId,
        conversation_id: suite.conversationId,
        principal: principalOf(suite, suite.memberId, "browser_session"),
      } as never,
      { message_hint: "x" },
    );
    expect(tool).toMatchObject({ ok: false, error_code: "notes_switched_off" });
    expect((await listNotes(suite.ctx.db, ownerOf(suite, suite.memberId))).length).toBe(count);
  });
});
