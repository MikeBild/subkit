import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations } from "../../db/schema/index.ts";
import { applySkillSeeds, loadEmbeddedSkillSeeds } from "../../skills/seed.ts";
import { createConversation } from "../service/create.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("intake-preload");
  await applySkillSeeds(loadEmbeddedSkillSeeds().skills, ctx.tenant_id, ctx.testDb.db);
});

afterAll(async () => {
  await ctx.cleanup();
});

async function loadedSlugs(conversation_id: string): Promise<string[]> {
  const [row] = await ctx.testDb.db
    .select({ loaded_skills: conversations.loaded_skills })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)))
    .limit(1);
  return (row?.loaded_skills ?? []).map((entry) => entry.slug);
}

describe("intake review conversations load the review skill", () => {
  test("a selected intake review starts with the review skill loaded", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        intake_item_ids: ["10000000-0000-4000-8000-0000000000a1"],
      },
      ctx.testDb.db,
    );
    expect(await loadedSlugs(created.conversation.id)).toContain("intake-review-to-knowledge");
  });

  test("an ordinary conversation does not preload it", async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
      ctx.testDb.db,
    );
    expect(await loadedSlugs(created.conversation.id)).not.toContain("intake-review-to-knowledge");
  });
});
