// Regression for cli-ca6be21a (slug-as-UUID skill lookup):
//
// `loaded_skill_slugs` carries skill SLUGS (e.g. "workflow-authoring"
// from the auto-loaded authoring constants in conversations/loop.ts and
// from the seed loader). The resolver in context-assembler must match
// by slug first; the last-resort fetch must not pass a slug into a
// uuid-typed `id` query. Pre-fix this caused HTTP 500 on every chat
// turn that re-entered the loop after `commit_workflow_draft` approval.
//
// The test pins:
//   1. A bare slug resolves the seeded row (slug match on listSkills).
//   2. An unknown slug is silently skipped (does not throw, does not 500).
//   3. The DB call path tolerates a non-UUID input (verifies the
//      getSkill UUID guard is also in place).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { skills } from "../../db/schema/index.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = process.env.SKIP_DB_TESTS === "1";

let ctx: LlmTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("loaded-slugs");

  // Stamp a slug onto the seeded global skill so the resolver has
  // something to match against. The seed loader does the equivalent
  // for real seed-managed skills.
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
        max_tokens: 8000,
        model: "mock",
        loaded_skill_slugs: ["workflow-authoring"],
      },
      ctx.testDb.db,
    );
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
  });

  test("unknown slug does not throw and is skipped", async () => {
    // Pre-fix this hit getSkill(slug) → uuid bind error → 500. Now it
    // routes to getSkillBySlug, which returns null for a missing row,
    // and the resolver moves on.
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "build a workflow" }],
        max_tokens: 8000,
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
        max_tokens: 8000,
        model: "mock",
        loaded_skill_slugs: ["workflow-authoring", ctx.skill_ids.connector, "ghost-slug"],
      },
      ctx.testDb.db,
    );
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.connector);
  });
});
