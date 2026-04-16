// Undo test — walking the snapshot history backwards reverts the
// most recent mutation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendSnapshot, loadDraft, undoLastSnapshot } from "../draft.ts";
import { createConversation } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("undo");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("conversations/draft.undo", () => {
  test("undo pops the newest snapshot and restores the previous one", async () => {
    const outcome = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    const convId = outcome.conversation.id;

    // Snapshot v1: empty
    const v1 = { name: "v1", steps: [] as Array<Record<string, unknown>> };
    await appendSnapshot(ctx.tenant_id, convId, v1, ctx.testDb.db);

    // Snapshot v2: one step
    const v2 = {
      name: "v2",
      steps: [{ kind: "request", id: "s1", url: "https://example.test" }],
    };
    await appendSnapshot(ctx.tenant_id, convId, v2, ctx.testDb.db);

    // Snapshot v3: two steps
    const v3 = {
      name: "v3",
      steps: [
        { kind: "request", id: "s1", url: "https://example.test" },
        { kind: "transform", id: "s2", expression: "$" },
      ],
    };
    await appendSnapshot(ctx.tenant_id, convId, v3, ctx.testDb.db);

    const loaded = await loadDraft(ctx.tenant_id, convId, ctx.testDb.db);
    expect(loaded.name).toBe("v3");
    expect(loaded.steps.length).toBe(2);

    // Undo → v2
    const afterUndo = await undoLastSnapshot(ctx.tenant_id, convId, ctx.testDb.db);
    expect(afterUndo.name).toBe("v2");
    expect(afterUndo.steps.length).toBe(1);

    // Undo → v1
    const afterSecondUndo = await undoLastSnapshot(ctx.tenant_id, convId, ctx.testDb.db);
    expect(afterSecondUndo.name).toBe("v1");
  });
});
