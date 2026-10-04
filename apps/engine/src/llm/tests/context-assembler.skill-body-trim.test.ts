import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { skills } from "../../db/schema/index.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: LlmTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("skill-body-trim");
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
  test("execution permission survives dropping a large authoring context", async () => {
    const params = {
      tenant_id: ctx.tenant_id,
      flow: "converse" as const,
      user_turns: [{ role: "user" as const, content: "Is the schedule ready?" }],
      model: "mock",
    };
    const baseline = await assembleEnhancedPrompt({ ...params, max_tokens: 50_000 }, ctx.testDb.db);
    const evidence =
      "AUTOMATIC OPERATION: single run completed; schedule repair_required; ready=false";
    const prompt = await assembleEnhancedPrompt(
      {
        ...params,
        max_tokens: baseline.token_counts.total + 500,
        authoring_context: "Large historical authoring context. ".repeat(10_000),
        automation_context: evidence,
      },
      ctx.testDb.db,
    );
    expect(prompt.system).toContain(evidence);
    expect(prompt.system).not.toContain("Large historical authoring context.");
    expect(prompt.token_counts.total).toBeLessThanOrEqual(baseline.token_counts.total + 500);
  });

  test("ambient skill body renders in summary form — body never inlined", async () => {
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
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
    expect(prompt.system).toMatch(/long-skill|load_skill/);
    expect(prompt.system.length).toBeLessThan(40_000);
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
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
    expect(prompt.system.length).toBeLessThan(40_000);
  });
});
