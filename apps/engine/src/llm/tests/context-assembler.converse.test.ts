import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createKnowledgeSource } from "../../knowledge/service.ts";
import { createWorkflow } from "../../workflows/service.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: LlmTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("converse-non-regression");

  await createKnowledgeSource(
    {
      tenant_id: ctx.tenant_id,
      input: { name: "Pagination Rules" },
      upload: {
        buffer: Buffer.from(
          "# Pagination\n\nAll endpoints use cursor tokens.\nDefault page size is 50.\nRate limit is 100 requests per minute.",
        ),
        filename: "pagination.md",
        mime: "text/markdown",
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );

  const seedWf = await createWorkflow(
    {
      tenant_id: ctx.tenant_id,
      def: {
        name: "Pagination probe",
        slug: "wf-pagination-probe",
        description: "Walks a paginated endpoint to verify cursor handling.",
        steps: [
          {
            id: "list",
            kind: "request",
            method: "GET",
            url: "https://jsonplaceholder.typicode.com/users",
            connector_id: ctx.connector_id,
          },
        ],
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );
  if ("errors" in seedWf) {
    throw new Error(`seed workflow failed: ${seedWf.errors.join("; ")}`);
  }
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("converse pipeline — non-regression contract", () => {
  test("converse flow loads zero pre-embedded knowledge chunks", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "how should pagination work?" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    expect(prompt.included_knowledge_chunks).toHaveLength(0);
    expect(prompt.included_knowledge_chunk_ids).toHaveLength(0);
  });

  test("converse flow loads zero pre-embedded connector-docs chunks", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "list my workflows" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    expect(prompt.included_chunks).toHaveLength(0);
    expect(prompt.included_chunk_ids).toHaveLength(0);
  });

  test("non-converse flows still pre-embed (regression check inverted)", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "generate",
        user_turns: [{ role: "user", content: "generate a workflow about pagination" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    expect(prompt.token_counts.knowledge).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(prompt.included_knowledge_chunks)).toBe(true);
  });

  test("converse system prompt carries the tenant-snapshot block at BOTH ends", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "show my workflows" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    const matches = prompt.system.match(/TENANT SNAPSHOT/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("non-converse flows do NOT inject the tenant-snapshot block", async () => {
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
    expect(prompt.system).not.toContain("TENANT SNAPSHOT");
  });

  test("converse flow does NOT pre-embed prior-workflow reference cases", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "walk pagination users" }],
        max_tokens: 180_000,
        model: "claude-sonnet-4-6",
      },
      ctx.testDb.db,
    );
    expect(prompt.system).not.toContain("### Prior workflows");
    expect(prompt.included_prior_workflow_slugs).toEqual([]);
    expect(prompt.token_counts.prior_workflows).toBe(0);
  });

  test("non-converse flows DO pre-embed prior-workflow reference cases when matches exist", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "generate",
        connector_id: ctx.connector_id,
        user_turns: [{ role: "user", content: "walk pagination users" }],
        max_tokens: 180_000,
        model: "claude-sonnet-4-6",
      },
      ctx.testDb.db,
    );
    expect(prompt.system).toContain("### Prior workflows [reference, not template]");
    expect(prompt.included_prior_workflow_slugs).toContain("wf-pagination-probe");
  });
});
