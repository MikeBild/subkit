import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendSnapshot, loadDraft, undoLastSnapshot } from "../draft.ts";
import { createConversation } from "../service/index.ts";
import type { DraftDocument } from "../types.ts";
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

    const v1: DraftDocument = { workflow: { name: "v1", steps: [] } };
    await appendSnapshot(ctx.tenant_id, convId, v1, ctx.testDb.db);

    const v2: DraftDocument = {
      workflow: {
        name: "v2",
        steps: [{ kind: "request", id: "s1", url: "https://example.test" }],
      },
    };
    await appendSnapshot(ctx.tenant_id, convId, v2, ctx.testDb.db);

    const v3: DraftDocument = {
      workflow: {
        name: "v3",
        steps: [
          { kind: "request", id: "s1", url: "https://example.test" },
          { kind: "transform", id: "s2", expression: "$" },
        ],
      },
    };
    await appendSnapshot(ctx.tenant_id, convId, v3, ctx.testDb.db);

    const loaded = await loadDraft(ctx.tenant_id, convId, ctx.testDb.db);
    expect(loaded.workflow.name).toBe("v3");
    expect(loaded.workflow.steps.length).toBe(2);

    const afterUndo = await undoLastSnapshot(ctx.tenant_id, convId, ctx.testDb.db);
    expect(afterUndo.workflow.name).toBe("v2");
    expect(afterUndo.workflow.steps.length).toBe(1);

    const afterSecondUndo = await undoLastSnapshot(ctx.tenant_id, convId, ctx.testDb.db);
    expect(afterSecondUndo.workflow.name).toBe("v1");
  });
});
