import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ConversationTool } from "../../conversations/tools/index.ts";
import { auditLog, intakeItems, personalNotes } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import type { NoteWrite } from "../core/apply-proposals.ts";
import { DEFAULT_EXPORT_LABELS } from "../core/export-markdown.ts";
import { loadPersonalNotesBlock } from "../prompt-block.ts";
import { openField } from "../sealing.ts";
import { applyNoteWrites, getNote, listNotes } from "../service.ts";
import {
  findMyNotesTool,
  PERSONAL_NOTES_TOOLS,
  readMyNoteTool,
  rememberForMeTool,
} from "../tools.ts";
import { AT, addMessage, callNotes, ownerOf, principalOf, setupNotesSuite } from "./notes-suite.ts";

const nextId = createDeterministicUuidFactory(0x0e5_9ab);

const suite = setupNotesSuite("notes-privacy");

function create(slug: string, text: string, message_id: string, abstract = text): NoteWrite {
  return {
    kind: "create",
    area: "preferences",
    slug,
    origin: "stated",
    fact_kind: "preference",
    text,
    abstract,
    confirmed: false,
    source: { message_id, conversation_id: suite.conversationId, quote: text },
  };
}

describe("personal notes stay with their person", () => {
  let noteId: string;

  test("a note is stored encrypted and bound to its person and its field", async () => {
    const message = await addMessage(
      suite,
      suite.conversationId,
      "user",
      { text: "I prefer answers in short bullet points." },
      new Date("2026-11-01T08:00:00.000Z"),
    );
    const applied = await applyNoteWrites(
      suite.ctx.db,
      ownerOf(suite, suite.memberId),
      [create("answer-style", "Prefers answers in short bullet points.", message, "Short bullets")],
      "learning",
      AT,
    );
    expect(applied).toEqual({ applied: 1, skipped: 0 });
    const [row] = await suite.ctx.db
      .select()
      .from(personalNotes)
      .where(
        and(
          eq(personalNotes.tenant_id, suite.ctx.tenantId),
          eq(personalNotes.user_id, suite.memberId),
        ),
      );
    if (!row) throw new Error("note row missing");
    noteId = row.id;
    expect(Buffer.from(row.text_ciphertext).toString("utf8")).not.toContain("bullet");
    const sealed = {
      ciphertext: row.text_ciphertext,
      iv: row.text_iv,
      auth_tag: row.text_auth_tag,
    };
    expect(openField(ownerOf(suite, suite.memberId), row.id, "text", sealed)).toBe(
      "Prefers answers in short bullet points.",
    );
    expect(() => openField(ownerOf(suite, suite.ctx.userId), row.id, "text", sealed)).toThrow();
    expect(() => openField(ownerOf(suite, suite.memberId), nextId(), "text", sealed)).toThrow();
    expect(() => openField(ownerOf(suite, suite.memberId), row.id, "abstract", sealed)).toThrow();
    expect(() =>
      openField({ tenant_id: nextId(), user_id: suite.memberId }, row.id, "text", sealed),
    ).toThrow();
  });

  test("a row moved to another person cannot be read by them", async () => {
    await suite.ctx.db
      .update(personalNotes)
      .set({ user_id: suite.ctx.userId })
      .where(and(eq(personalNotes.tenant_id, suite.ctx.tenantId), eq(personalNotes.id, noteId)));
    await expect(listNotes(suite.ctx.db, ownerOf(suite, suite.ctx.userId))).rejects.toThrow();
    await suite.ctx.db
      .update(personalNotes)
      .set({ user_id: suite.memberId })
      .where(and(eq(personalNotes.tenant_id, suite.ctx.tenantId), eq(personalNotes.id, noteId)));
    expect(await listNotes(suite.ctx.db, ownerOf(suite, suite.memberId))).toHaveLength(1);
  });

  test("the person reads their note with the quote it came from", async () => {
    const listed = await callNotes(suite, "GET", "", suite.memberHeaders);
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    const detail = await callNotes(suite, "GET", `/${noteId}`, suite.memberHeaders);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: noteId,
      area: "preferences",
      status: "mentioned_once",
      text: "Prefers answers in short bullet points.",
      source_count: 1,
      earlier_versions: [],
    });
    expect((detail.body.sources as Array<Record<string, unknown>>)[0]).toMatchObject({
      quote: "Prefers answers in short bullet points.",
      conversation_id: suite.conversationId,
      channel: "web",
    });
  });

  test("an administrator gets 404 on another person's note and an empty list", async () => {
    expect((await callNotes(suite, "GET", "", suite.adminHeaders)).body).toEqual({
      notes: [],
      total: 0,
    });
    expect((await callNotes(suite, "GET", `/${noteId}`, suite.adminHeaders)).status).toBe(404);
    expect(
      (
        await callNotes(suite, "PUT", `/${noteId}`, suite.adminHeaders, {
          text: "Mine now",
          expected_version: 1,
        })
      ).status,
    ).toBe(404);
    for (const action of ["confirm", "archive", "restore"]) {
      expect(
        (await callNotes(suite, "POST", `/${noteId}/${action}`, suite.adminHeaders)).status,
      ).toBe(404);
    }
    expect(
      (await callNotes(suite, "POST", `/${noteId}/share`, suite.adminHeaders, { confirm: true }))
        .status,
    ).toBe(404);
    expect((await callNotes(suite, "DELETE", `/${noteId}`, suite.adminHeaders)).status).toBe(404);
    const exported = await callNotes(suite, "POST", "/export", suite.adminHeaders, {});
    expect(exported.body.count).toBe(0);
    expect(String(exported.body.markdown)).not.toContain("bullet");
    expect(await getNote(suite.ctx.db, ownerOf(suite, suite.memberId), noteId)).not.toBeNull();
  });

  test("an API key has no notes at all", async () => {
    const headers = {
      authorization: `Bearer ${suite.ctx.apiKey}`,
      "content-type": "application/json",
    };
    const listed = await callNotes(suite, "GET", "", headers);
    expect(listed.status).toBe(403);
    expect(listed.body.code).toBe("person_required");
    expect((await callNotes(suite, "GET", `/${noteId}`, headers)).status).toBe(403);
  });

  test("another person's turn never contains this person's abstract", async () => {
    const mine = await loadPersonalNotesBlock(
      {
        tenant_id: suite.ctx.tenantId,
        principal: principalOf(suite, suite.memberId, "browser_session"),
        query: "short answers please",
        context_cap: 100_000,
      },
      suite.ctx.db,
    );
    expect(mine).toContain("- (preferences) Short bullets");
    for (const other of [
      principalOf(suite, suite.ctx.userId, "browser_session"),
      principalOf(suite, suite.ctx.userId, "task_run"),
      { ...principalOf(suite, suite.memberId, "browser_session"), auth_source: undefined },
      { ...principalOf(suite, suite.memberId, "browser_session"), tenant_id: nextId() },
      null,
    ]) {
      const block = await loadPersonalNotesBlock(
        {
          tenant_id: suite.ctx.tenantId,
          principal: other as ResolvedPrincipal | null,
          query: "short bullets answers",
          context_cap: 100_000,
        },
        suite.ctx.db,
      );
      expect(block).toBeNull();
    }
    const taskRun = await loadPersonalNotesBlock(
      {
        tenant_id: suite.ctx.tenantId,
        principal: principalOf(suite, suite.memberId, "task_run"),
        query: "bullets",
        context_cap: 100_000,
      },
      suite.ctx.db,
    );
    expect(taskRun).toContain("Short bullets");
  });

  test("the tools read only the caller's notes and are not available without a person", async () => {
    const registrable: readonly ConversationTool[] = PERSONAL_NOTES_TOOLS;
    expect(registrable.map((tool) => tool.name)).toEqual([
      "remember_for_me",
      "find_my_notes",
      "read_my_note",
    ]);
    const base = {
      db: suite.ctx.db,
      tenant_id: suite.ctx.tenantId,
      conversation_id: suite.conversationId,
    };
    const asMember = {
      ...base,
      principal: principalOf(suite, suite.memberId, "browser_session"),
    } as never;
    const asAdmin = {
      ...base,
      principal: principalOf(suite, suite.ctx.userId, "browser_session"),
    } as never;
    const found = await findMyNotesTool.execute(asMember, { query: "bullet points" });
    expect(found).toMatchObject({ ok: true, data: { notes: [{ id: noteId }] } });
    expect(await findMyNotesTool.execute(asAdmin, { query: "bullet points" })).toMatchObject({
      ok: true,
      data: { notes: [] },
    });
    expect(await readMyNoteTool.execute(asAdmin, { id: noteId })).toMatchObject({
      ok: false,
      error_code: "not_found",
    });
    expect(await readMyNoteTool.execute(asMember, { id: noteId })).toMatchObject({
      ok: true,
      data: { note: { text: "Prefers answers in short bullet points." } },
    });
    const nobody = { ...base, principal: null } as never;
    for (const tool of [findMyNotesTool, readMyNoteTool, rememberForMeTool]) {
      const args =
        tool === readMyNoteTool
          ? { id: noteId }
          : tool === findMyNotesTool
            ? { query: "bullets" }
            : { message_hint: "bullets" };
      expect(await tool.execute(nobody, args)).toMatchObject({
        ok: false,
        error_code: "not_available",
      });
    }
    const taskRun = {
      ...base,
      principal: principalOf(suite, suite.memberId, "task_run"),
      task_run: { task_run_id: "r1" },
    } as never;
    expect(await rememberForMeTool.execute(taskRun, { message_hint: "bullets" })).toMatchObject({
      ok: false,
      error_code: "not_available",
    });
    expect(await findMyNotesTool.execute(taskRun, { query: "bullet points" })).toMatchObject({
      ok: true,
      data: { notes: [{ id: noteId }] },
    });
  });

  test("the audit log records the note without any of its text", async () => {
    const rows = await suite.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, suite.ctx.tenantId), eq(auditLog.resource_id, noteId)));
    expect(rows.map((row) => row.action)).toContain("personal_note.created");
    for (const row of rows) {
      expect(Object.keys(row.metadata as Record<string, unknown>).sort()).toEqual([
        "area",
        "bytes",
        "origin",
        "source_count",
      ]);
      expect(JSON.stringify(row)).not.toContain("bullet");
    }
  });

  test("editing keeps the old text as an earlier version, forgetting deletes the whole chain", async () => {
    const secret = `ghp_${"a1B2".repeat(9)}`;
    const refused = await callNotes(suite, "PUT", `/${noteId}`, suite.memberHeaders, {
      text: `My token is ${secret}`,
      expected_version: 1,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("secret_in_text");
    const stale = await callNotes(suite, "PUT", `/${noteId}`, suite.memberHeaders, {
      text: "Prefers numbered lists.",
      expected_version: 7,
    });
    expect(stale.status).toBe(409);
    const edited = await callNotes(suite, "PUT", `/${noteId}`, suite.memberHeaders, {
      text: "Prefers numbered lists.",
      expected_version: 1,
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ status: "confirmed", version: 2, origin: "stated" });
    const nextId = String(edited.body.id);
    expect(nextId).not.toBe(noteId);
    const detail = await callNotes(suite, "GET", `/${nextId}`, suite.memberHeaders);
    const earlier = detail.body.earlier_versions as Array<Record<string, unknown>>;
    expect(earlier).toHaveLength(1);
    expect(earlier[0]).toMatchObject({
      id: noteId,
      archive_reason: "superseded",
      text: "Prefers answers in short bullet points.",
    });
    expect(
      (await callNotes(suite, "POST", `/${noteId}/restore`, suite.memberHeaders)).body.code,
    ).toBe("address_taken");

    const exported = await callNotes(suite, "POST", "/export", suite.memberHeaders, {
      labels: { ...DEFAULT_EXPORT_LABELS, title: "Notes of mine" },
    });
    expect(String(exported.body.markdown)).toStartWith("# Notes of mine\n");
    expect(exported.body.count).toBe(1);
    expect(String(exported.body.markdown)).toContain("- Prefers numbered lists.");

    const unconfirmed = await callNotes(suite, "POST", `/${nextId}/share`, suite.memberHeaders, {
      confirm: false,
    });
    expect(unconfirmed.status).toBe(400);
    const shared = await callNotes(suite, "POST", `/${nextId}/share`, suite.memberHeaders, {
      confirm: true,
    });
    expect(shared.status).toBe(201);
    const [item] = await suite.ctx.db
      .select()
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.tenant_id, suite.ctx.tenantId),
          eq(intakeItems.id, String(shared.body.intake_item_id)),
        ),
      );
    expect(item?.body).toContain("Prefers numbered lists.");
    expect(item?.collected_by_id).toBe(suite.memberId);

    const archived = await callNotes(suite, "POST", `/${nextId}/archive`, suite.memberHeaders);
    expect(archived.body.archive_reason).toBe("manual");
    expect((await callNotes(suite, "GET", "", suite.memberHeaders)).body.total).toBe(0);
    expect((await callNotes(suite, "GET", "?archived=true", suite.memberHeaders)).body.total).toBe(
      2,
    );
    expect((await callNotes(suite, "POST", `/${nextId}/restore`, suite.memberHeaders)).status).toBe(
      200,
    );

    const forgotten = await callNotes(suite, "DELETE", `/${nextId}`, suite.memberHeaders);
    expect(forgotten.body).toEqual({ forgotten: 2 });
    const left = await suite.ctx.db
      .select({ id: personalNotes.id })
      .from(personalNotes)
      .where(eq(personalNotes.tenant_id, suite.ctx.tenantId));
    expect(left).toEqual([]);
    expect((await callNotes(suite, "GET", `/${nextId}`, suite.memberHeaders)).status).toBe(404);
  });
});
