import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { assembleEnhancedPrompt } from "../context.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("context");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("llm/context enhancement", () => {
  test("assembles sections in scope order with non-empty grounding", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "generate",
        connector_id: ctx.connector_id,
        user_turns: [{ role: "user", content: "users listing endpoint" }],
        max_tokens: 8_000,
        model: "claude-sonnet-4-5",
      },
      ctx.testDb.db,
    );

    // Section order: global skill → connector skill → (docs) → user turns.
    // The workflow skill is not applicable here (no workflow_id passed in).
    const sys = prompt.system;
    const globalIdx = sys.indexOf("prefer-get-for-lists");
    const connectorIdx = sys.indexOf("jsonplaceholder-users");
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(connectorIdx).toBeGreaterThan(globalIdx);

    // Docs section, if present, appears after the skills.
    const docsIdx = sys.indexOf("## Doc");
    if (docsIdx !== -1) {
      expect(docsIdx).toBeGreaterThan(connectorIdx);
    }

    // User turn is carried on `messages`, not the system block.
    expect(prompt.messages.length).toBe(1);
    expect(prompt.messages[0]?.content).toContain("users");

    // Token bookkeeping is populated.
    expect(prompt.token_counts.total).toBeGreaterThan(0);
    expect(prompt.token_counts.system).toBeGreaterThan(0);
    expect(prompt.token_counts.messages).toBeGreaterThan(0);
    expect(prompt.token_counts.skills).toBeGreaterThan(0);

    // Grounding is surfaced.
    expect(prompt.included_skill_ids.length).toBeGreaterThanOrEqual(2);
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.global);
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.connector);
  });

  test("doc chunks are pulled in when the tsvector matches", async () => {
    // Direct search against the seeded rows — asserts the connector's
    // ingested docs are retrievable at all. If this passes but the
    // first test still omits docs, the enhancement pipeline's query
    // builder is doing something funny.
    const { searchDocs } = await import("../../docs-ingestion/service.ts");
    const hits = await searchDocs(
      { tenant_id: ctx.tenant_id, connector_id: ctx.connector_id, query: "users" },
      ctx.testDb.db,
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "generate",
        connector_id: ctx.connector_id,
        user_turns: [{ role: "user", content: "users" }],
        max_tokens: 8_000,
        model: "claude-sonnet-4-5",
      },
      ctx.testDb.db,
    );
    expect(prompt.included_chunk_ids.length).toBeGreaterThanOrEqual(1);
    expect(prompt.system).toContain("## Doc");
  });

  test("workflow-scoped retrieval pulls the workflow skill in order", async () => {
    // Re-derive the same workflow_id by querying the seeded workflow skill.
    // The workflow skill was seeded with a random uuid; fetch it back.
    const rows = await ctx.testDb.db.execute(
      sql`SELECT workflow_id::text AS workflow_id FROM skills WHERE id = ${ctx.skill_ids.workflow}`,
    );
    const list = (rows as unknown as { rows?: Array<{ workflow_id: string }> }).rows ?? [];
    const workflow_id = list[0]?.workflow_id;
    expect(workflow_id).toBeTruthy();

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "generate",
        connector_id: ctx.connector_id,
        workflow_id: workflow_id as string,
        user_turns: [{ role: "user", content: "guard midnight rollovers" }],
        max_tokens: 8_000,
        model: "claude-sonnet-4-5",
      },
      ctx.testDb.db,
    );
    expect(prompt.included_skill_ids).toContain(ctx.skill_ids.workflow);
    // Workflow skill should appear after the connector skill in the
    // system block, reflecting scope ordering.
    const connectorIdx = prompt.system.indexOf("jsonplaceholder-users");
    const workflowIdx = prompt.system.indexOf("midnight-guard");
    expect(connectorIdx).toBeGreaterThanOrEqual(0);
    expect(workflowIdx).toBeGreaterThan(connectorIdx);
  });
});
