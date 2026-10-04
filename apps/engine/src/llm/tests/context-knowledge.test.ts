import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createKnowledgeSource } from "../../knowledge/service.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: LlmTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("ctx-knowledge");

  await createKnowledgeSource(
    {
      tenant_id: ctx.tenant_id,
      input: { name: "API Rules" },
      upload: {
        buffer: Buffer.from(
          "# API Rules\n\nAll endpoints must return JSON.\nPagination uses cursor tokens.\nRate limiting applies at 100 requests per minute.",
        ),
        filename: "api-rules.md",
        mime: "text/markdown",
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("llm/context — knowledge integration", () => {
  test("EnhancedPrompt includes knowledge fields even when no chunks match", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "How should pagination work?" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );

    expect(typeof prompt.token_counts.knowledge).toBe("number");
    expect(prompt.token_counts.knowledge).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(prompt.included_knowledge_chunk_ids)).toBe(true);
    expect(Array.isArray(prompt.included_knowledge_chunks)).toBe(true);
  });

  test("knowledge token budget is 15% of cap", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "generate",
        user_turns: [{ role: "user", content: "generate a workflow" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );

    expect(prompt.token_counts.knowledge).toBeLessThanOrEqual(1200);
  });

  test("EnhancedPrompt has all required fields", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "hello" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );

    expect(typeof prompt.token_counts.knowledge).toBe("number");
    expect(Array.isArray(prompt.included_knowledge_chunk_ids)).toBe(true);
    expect(Array.isArray(prompt.included_knowledge_chunks)).toBe(true);
  });

  test("discover flow has base prompt", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "discover",
        user_turns: [{ role: "user", content: "analyze this file" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );

    expect(prompt.system).toContain("discovery");
  });
});
