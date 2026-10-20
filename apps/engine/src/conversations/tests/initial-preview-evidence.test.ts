import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { createConversation, getConversation } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("initial_preview_evidence");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("conversation preview evidence", () => {
  test("a GitHub authoring request starts without invented preview evidence", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "Create a workflow for GitHub private repos",
      },
      ctx.testDb.db,
    );
    const stored = await getConversation(ctx.tenant_id, created.conversation.id, ctx.testDb.db);
    expect(stored?.draft?.latest_preview).toBeUndefined();
  });

  test("a real provider does not receive a canned GitHub authoring plan", async () => {
    await setConfigKey("llm.provider", "anthropic", { tenantId: ctx.tenant_id, force: true });
    try {
      const created = await createConversation(
        {
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          initial_message: "Create a workflow for GitHub private repos",
        },
        ctx.testDb.db,
      );
      expect(getMockProvider().conversePlans.has(created.conversation.id)).toBe(false);
      const stored = await getConversation(ctx.tenant_id, created.conversation.id, ctx.testDb.db);
      expect(stored?.draft?.latest_preview).toBeUndefined();
    } finally {
      await setConfigKey("llm.provider", "mock", { tenantId: ctx.tenant_id, force: true });
    }
  });
});
