import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createKnowledgeSource } from "../../knowledge/service.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { assembleEnhancedPrompt } from "../runtime/context-assembler.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = testEnv.REQUIRES_PG === "0";

let ctx: LlmTestCtx;

const USER_TURNS = [{ role: "user" as const, content: "users" }];

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("summarize-no-corpus");
  await createKnowledgeSource(
    {
      tenant_id: ctx.tenant_id,
      input: { name: "Users Runbook" },
      upload: {
        buffer: Buffer.from(
          "# Users\n\nUsers are listed from /users with cursor pagination. Each user carries id, name and email.",
        ),
        filename: "users.md",
        mime: "text/markdown",
      },
      actor: null,
    },
    ctx.testDb.db,
  );
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("summarize flow — assembled without the retrieval corpus", () => {
  test("the same input pulls knowledge and connector docs into a generate prompt", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "generate",
        connector_id: ctx.connector_id,
        user_turns: USER_TURNS,
        max_tokens: 12_000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    expect(prompt.included_knowledge_chunk_ids.length).toBeGreaterThanOrEqual(1);
    expect(prompt.included_chunk_ids.length).toBeGreaterThanOrEqual(1);
  });

  test("a summarize prompt carries no knowledge chunks, no docs chunks and no prior workflows", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "summarize",
        connector_id: ctx.connector_id,
        user_turns: USER_TURNS,
        max_tokens: 12_000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    expect(prompt.included_knowledge_chunk_ids).toEqual([]);
    expect(prompt.included_knowledge_chunks).toEqual([]);
    expect(prompt.included_chunk_ids).toEqual([]);
    expect(prompt.included_chunks).toEqual([]);
    expect(prompt.included_prior_workflow_slugs).toEqual([]);
    expect(prompt.token_counts.knowledge).toBe(0);
    expect(prompt.token_counts.docs).toBe(0);
    expect(prompt.messages.map((m) => m.content)).toEqual(["users"]);
  });
});
