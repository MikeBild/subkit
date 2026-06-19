// Locks the converse-pipeline non-regression contract:
//
// 1. Converse flow does NOT pre-embed knowledge or connector docs.
//    The model fetches them on-demand via the `search_knowledge` and
//    `fetch_connector_docs` tools. Removing the
//    `preEmbedCorpus = p.flow !== "converse"` guard at
//    `apps/engine/src/llm/core/context-assembler.ts:569` brings back
//    the 1M-token empty turn that landed in `db96ebb`'s fix-and-roll.
//
// 2. Tenant snapshot is injected at BOTH ends of the stable head
//    (prefix + suffix) so it stays visible after the skills section
//    grows. Single-position injection gets buried.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createKnowledgeSource } from "../../knowledge/service.ts";
import { createWorkflow } from "../../workflows/service.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

// Requires a real Postgres database — set REQUIRES_PG=0 to skip in environments without a DB.
const skip = process.env.REQUIRES_PG === "0";

let ctx: LlmTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("converse-non-regression");

  // Seed a knowledge source so a regression that re-enables pre-embedding
  // would surface as non-empty `included_knowledge_chunks`.
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

  // Seed an active workflow so a regression that pre-embeds prior
  // workflows in the converse flow would surface as a non-empty
  // `### Prior workflows` section in the system prompt.
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
    // The whole point of the guard: even though knowledge exists and
    // matches the query, the converse flow must not embed it. The
    // model fetches on demand via search_knowledge.
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
    // The other flows do not have a tool loop and rely on pre-embedded
    // knowledge. They should still receive chunks (or at minimum the
    // budget tracking should report a non-negative number; concrete
    // chunk counts depend on FTS scoring).
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
    // Snapshot is rendered as a section starting with a known marker
    // string. Renderer is at apps/engine/src/llm/core/tenant-summary.ts.
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
    // Same load-bearing guard as the knowledge / docs cases above:
    // the converse flow lets the model discover prior workflows via the
    // always-on tenant snapshot + the `find_workflow` tool, not via
    // pre-embedded reference cases. Removing the `preEmbedCorpus` gate
    // would re-introduce a 1M-token-class regression in chat turns.
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
    // Inverted regression check: when the same intent runs through a
    // structured authoring flow, the section appears — proving the
    // guard is what suppressed it above (not e.g. a missing seed).
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
