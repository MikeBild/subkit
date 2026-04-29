// operator_notes injection contract.
//
// When a connector carries `operator_notes`, the context assembler
// must render an "Operator notes" block in the stable head (so it
// caches alongside skills) whenever that connector is in scope.
// Empty / null notes leave the prompt unchanged.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors } from "../../db/schema/index.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = process.env.SKIP_DB_TESTS === "1";

let ctx: LlmTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("operator-notes");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("context-assembler — operator_notes", () => {
  test("connector without notes produces no operator-notes block", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        connector_id: ctx.connector_id,
        user_turns: [{ role: "user", content: "list users" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    expect(prompt.system).not.toContain("Operator notes");
  });

  test("connector with notes injects them into the stable head", async () => {
    await ctx.testDb.db
      .update(connectors)
      .set({ operator_notes: "always send `?api-version=2025-01-01`" })
      .where(eq(connectors.id, ctx.connector_id));

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        connector_id: ctx.connector_id,
        user_turns: [{ role: "user", content: "list users" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    expect(prompt.system).toContain("Operator notes");
    expect(prompt.system).toContain("always send `?api-version=2025-01-01`");
    // The block carries the slug + display name so two connectors in
    // scope on the same turn never blur together.
    expect(prompt.system).toMatch(/Operator notes — connector `api-operator-notes`/);
  });

  test("empty / whitespace-only notes are ignored", async () => {
    await ctx.testDb.db
      .update(connectors)
      .set({ operator_notes: "   \n  " })
      .where(eq(connectors.id, ctx.connector_id));

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        connector_id: ctx.connector_id,
        user_turns: [{ role: "user", content: "list users" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    expect(prompt.system).not.toContain("Operator notes");
  });

  test("notes for one connector do not bleed into another connector's prompt", async () => {
    await ctx.testDb.db
      .update(connectors)
      .set({ operator_notes: "this should NOT appear when scoped to a different connector" })
      .where(eq(connectors.id, ctx.connector_id));

    // Assemble without specifying a connector_id — operator_notes
    // must not appear at all when the assembler has no connector
    // scope to attach them to.
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "x" }],
        max_tokens: 12000,
        model: "mock",
      },
      ctx.testDb.db,
    );
    expect(prompt.system).not.toContain("this should NOT appear");
    expect(prompt.system).not.toContain("Operator notes");
  });
});
