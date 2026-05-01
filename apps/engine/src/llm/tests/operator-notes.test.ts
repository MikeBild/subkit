// operator_quirks injection contract (migration 0006 — replaces the
// legacy `operator_notes` blob with categorized quirks).
//
// When a connector carries `operator_quirks`, the context assembler
// must render an "Operator quirks" block in the stable head whenever
// that connector is in scope. The per-turn category picker decides
// which slots ship; this test exercises the default ("idle") path
// where only `general` is rendered, plus the "no auth quirks while
// transforming" invariant by switching the AuthoringPromptHint stage.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors } from "../../db/schema/index.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";
import type { AuthoringPromptHint } from "../types.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = process.env.SKIP_DB_TESTS === "1";

let ctx: LlmTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("operator-quirks");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

function hint(stage: AuthoringPromptHint["stage"]): AuthoringPromptHint {
  return {
    mode: "AUTHORING",
    stage,
    lifecycle_state: "draft_only",
    active_target: { kind: "workflow", lifecycle_state: "draft_only" },
    blocked_by: [],
    next_required_action: null,
    next_suggested_tool: null,
    checkpoints: [],
    latest_execution: null,
    latest_diagnosis: null,
  } as unknown as AuthoringPromptHint;
}

describe.skipIf(skip)("context-assembler — operator_quirks", () => {
  test("connector with empty quirks produces no operator-quirks block", async () => {
    await ctx.testDb.db
      .update(connectors)
      .set({ operator_quirks: {} })
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
    expect(prompt.system).not.toContain("Operator quirks");
  });

  test("general quirk renders by default (idle stage)", async () => {
    await ctx.testDb.db
      .update(connectors)
      .set({ operator_quirks: { general: "always send `?api-version=2025-01-01`" } })
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
    expect(prompt.system).toContain("Operator quirks");
    expect(prompt.system).toContain("always send `?api-version=2025-01-01`");
  });

  test("auth quirk does NOT appear during a workflow_validated turn", async () => {
    await ctx.testDb.db
      .update(connectors)
      .set({
        operator_quirks: {
          auth: "this is auth quirk that must be hidden during transforms",
          schema: "amounts are in cents",
        },
      })
      .where(eq(connectors.id, ctx.connector_id));

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        connector_id: ctx.connector_id,
        user_turns: [{ role: "user", content: "validate the workflow" }],
        max_tokens: 12000,
        model: "mock",
        authoring_hint: hint("workflow_validated"),
      },
      ctx.testDb.db,
    );
    expect(prompt.system).not.toContain("auth quirk that must be hidden");
    expect(prompt.system).toContain("amounts are in cents");
  });

  test("quirks for one connector do not bleed into a no-connector turn", async () => {
    await ctx.testDb.db
      .update(connectors)
      .set({ operator_quirks: { general: "this should NOT appear when scoped to no connector" } })
      .where(eq(connectors.id, ctx.connector_id));

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
    expect(prompt.system).not.toContain("Operator quirks");
  });
});
