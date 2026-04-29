// Skill-body trim under context budget pressure (#27). Pre-fix the
// trimmer popped whole skill records when the context exceeded the
// model cap, removing the skill name + scope hint from the model's
// view entirely. Post-fix: trim each skill body to a 200-char summary
// + a "call load_skill to re-fetch" hint FIRST; only after every
// loaded skill is summarized do we start popping. Keeps the LLM aware
// the skill exists and how to recover the full body.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { skills } from "../../db/schema/index.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = process.env.SKIP_DB_TESTS === "1";

let ctx: LlmTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("skill-body-trim");
  // Replace the seeded skill body with a long text so the trim path
  // has something meaningful to slice. Slug stays addressable so the
  // post-trim hint can name it.
  const longBody = "X".repeat(40000) + "\nstructured content";
  await ctx.testDb.db
    .update(skills)
    .set({ slug: "long-skill", body: longBody, seed_source: "test-fixture" })
    .where(eq(skills.id, ctx.skill_ids.global));
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("context-assembler skill-body trim", () => {
  test("trims skill body to summary line when over cap, keeping the skill visible", async () => {
    // Use a tight token cap so the trimmer kicks in. The exact cap
    // isn't important — what matters is that the skill stays in the
    // included_skill_ids list while its body gets compacted.
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "anything" }],
        max_tokens: 30_000,
        model: "mock",
        loaded_skill_slugs: ["long-skill"],
      },
      ctx.testDb.db,
    );
    // Skill is NOT popped — the title + a short body remain.
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
    // The system prompt mentions the skill title or a load_skill hint.
    expect(prompt.system).toMatch(/long-skill|load_skill/);
    // The 40000-char body did NOT make it through verbatim. After
    // trim, the body is summarized to ~200 chars + a load_skill hint.
    expect(prompt.system.length).toBeLessThan(40_000);
    // Trim trail surfaces in the dropped_sections diagnostics.
    // The seeded skill is global-scope (no loaded_skill_slugs match
    // here when slug isn't recognized as a load directive — it
    // appears as global). Either trim flag is acceptable.
    const trimSeen =
      prompt.dropped_sections.includes("loaded_skill_body_trimmed") ||
      prompt.dropped_sections.includes("global_skill_body_trimmed");
    expect(trimSeen).toBe(true);
  });
});
