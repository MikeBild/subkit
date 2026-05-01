// Skill-body trim under context budget pressure (#27).
//
// Two layers protect the prompt:
//  1. Render-time: ambient skills (global / connector / workflow
//     scope) render as a per-scope INDEX block via
//     `formatSkillIndex` — one line per skill (slug + title + first
//     non-heading line, ≤120 chars). The full body is never inlined
//     unless the LLM explicitly calls `load_skill`.
//  2. Trim-time: when the prompt still exceeds the cap, the trim
//     ladder pops in priority order. Loaded skill bodies are
//     compacted via `trimSkill` first, then entire ambient index
//     blocks are dropped (workflow → connector → global).
//
// This test pins layer 1 specifically: a 40k-char skill with NO
// `load_skill` call must not bloat the prompt — the assembler
// renders the index entry and the body never reaches the prompt.

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
  const longBody = `${"X".repeat(40000)}\nstructured content`;
  await ctx.testDb.db
    .update(skills)
    .set({ slug: "long-skill", body: longBody, seed_source: "test-fixture" })
    .where(eq(skills.id, ctx.skill_ids.global));
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("context-assembler skill-body trim", () => {
  test("ambient skill body renders in summary form — body never inlined", async () => {
    // Without a load_skill call, the 40k-char skill body must NOT
    // appear in the prompt — only the summary form (title +
    // description + load_skill hint).
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "anything" }],
        max_tokens: 50_000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    // Skill is in the included list (visible to the model).
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
    // The system prompt mentions the skill title or a load_skill hint.
    expect(prompt.system).toMatch(/long-skill|load_skill/);
    // The 40000-char body did NOT make it through. Summary form is
    // ~200 chars total per skill.
    expect(prompt.system.length).toBeLessThan(40_000);
    // The body's bulk content (the 40k Xs) is NOT in the prompt.
    expect(prompt.system).not.toMatch(/X{1000,}/);
  });

  test("explicit load_skill inlines the full body, then trim path activates under cap", async () => {
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
    // Skill stays referenced.
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
    // Even with explicit load + tight cap, the prompt is bounded.
    expect(prompt.system.length).toBeLessThan(40_000);
  });
});
