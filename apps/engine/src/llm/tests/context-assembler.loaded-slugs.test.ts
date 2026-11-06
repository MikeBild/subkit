import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { skills } from "../../db/schema/index.ts";
import { assembleEnhancedPrompt } from "../runtime/context-assembler.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: LlmTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("loaded-slugs");

  await ctx.testDb.db
    .update(skills)
    .set({ slug: "workflow-authoring", seed_source: "test-fixture" })
    .where(eq(skills.id, ctx.skill_ids.global));
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("context-assembler loaded_skill_slugs resolution", () => {
  test("resolves a skill by its slug", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "build a workflow" }],
        max_tokens: 12000,
        model: "mock",
        loaded_skill_slugs: ["workflow-authoring"],
      },
      ctx.testDb.db,
    );
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
  });

  test("unknown slug does not throw and is skipped", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "build a workflow" }],
        max_tokens: 12000,
        model: "mock",
        loaded_skill_slugs: ["this-skill-does-not-exist"],
      },
      ctx.testDb.db,
    );
    expect(prompt.included_skill_ids).not.toContain("this-skill-does-not-exist");
  });

  test("mixed slug + uuid + unknown all coexist", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "build a workflow" }],
        max_tokens: 12000,
        model: "mock",
        loaded_skill_slugs: ["workflow-authoring", ctx.skill_ids.connector, "ghost-slug"],
      },
      ctx.testDb.db,
    );
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.connector);
  });
});
