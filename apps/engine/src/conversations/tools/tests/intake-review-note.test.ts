import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createIntakeItem, patchIntakeItem } from "../../../knowledge/index.ts";
import { createKnowledgeTestCtx, type KnowledgeTestCtx } from "../../../knowledge/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import type { DraftDocument } from "../../types.ts";
import {
  INTAKE_REVIEW_REMOVED_TOOLS,
  intakeReviewNote,
  intakeSelectionStatus,
  removeIntakeReviewTools,
} from "../sdk-wrap/intake-review-guard.ts";

const nextUuid = createDeterministicUuidFactory(0x4e07_e000);
const actor = { kind: "system_account" as const, id: nextUuid() };
let ctx: KnowledgeTestCtx;

beforeAll(async () => {
  ctx = await createKnowledgeTestCtx("intake-review-note");
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, 30_000);

function reviewDraft(ids: string[]): DraftDocument {
  return {
    ...createEmptyDraftDocument(),
    session: { intake_item_ids: ids, intake_review_locked: true },
  };
}

async function clip(title: string) {
  return createIntakeItem(
    {
      tenant_id: ctx.tenantId,
      actor,
      client_request_id: nextUuid(),
      title,
      source_url: "https://example.test/clip",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "Collected text.",
    },
    ctx.testDb.db,
  );
}

describe("intake review palette note", () => {
  test("removes the knowledge edit tools only during a review", () => {
    const tools = Object.fromEntries(
      [...INTAKE_REVIEW_REMOVED_TOOLS, "get_knowledge_source"].map((name) => [name, {}]),
    );
    expect(removeIntakeReviewTools(tools, createEmptyDraftDocument())).toEqual([]);
    expect(removeIntakeReviewTools(tools, reviewDraft([nextUuid()]))).toEqual([
      ...INTAKE_REVIEW_REMOVED_TOOLS,
    ]);
    expect(Object.keys(tools)).toEqual(["get_knowledge_source"]);
  });

  test("the note names the normal chat for editing existing knowledge", () => {
    const note = intakeReviewNote("open");
    expect(note).toContain("intake review");
    expect(note).toContain("normal chat");
    expect(note).not.toContain("already admitted or discarded");
  });

  test("a selection with an open item keeps the plain note", async () => {
    const open = await clip("Open clip");
    expect(await intakeSelectionStatus(ctx.testDb.db, ctx.tenantId, reviewDraft([open.id]))).toBe(
      "open",
    );
  });

  test("a fully decided selection says so explicitly and keeps the lock", async () => {
    const item = await clip("Decided clip");
    await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: item.version,
        state: "discarded",
      },
      ctx.testDb.db,
    );
    const draft = reviewDraft([item.id]);
    const status = await intakeSelectionStatus(ctx.testDb.db, ctx.tenantId, draft);
    expect(status).toBe("all_decided");
    expect(intakeReviewNote(status)).toContain("already admitted or discarded");
    expect(removeIntakeReviewTools({ update_knowledge_source: {} }, draft)).toEqual([
      "update_knowledge_source",
    ]);
  });

  test("items of another tenant are never counted as decided", async () => {
    const item = await clip("Tenant scoped clip");
    expect(await intakeSelectionStatus(ctx.testDb.db, nextUuid(), reviewDraft([item.id]))).toBe(
      "unknown",
    );
  });
});
