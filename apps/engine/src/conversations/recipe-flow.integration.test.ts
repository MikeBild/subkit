// Recipe-flow integration test.
//
// Pins the contract that `start_workflow_from_recipe` clones a recipe
// from the live `templates.json` catalog into a draft document that
// (a) preserves the recipe's `derived_from_skill` linkage, and
// (b) substitutes a placeholder `connector_id` when the operator
//     supplied a real one.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createEmptyDraftDocument } from "./authoring-state.ts";
import { startWorkflowFromRecipeTool } from "./tools/start-workflow-from-recipe.ts";
import type { DraftDocument } from "./types.ts";

const skip = process.env.SKIP_DB_TESTS === "1";
let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("recipe-flow");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "recipe-flow", display_name: "rf" })
    .returning();
  tenant_id = t!.id;
  const [c] = await ctx.db
    .insert(conversations)
    .values({
      tenant_id,
      status: "active",
      draft: createEmptyDraftDocument(),
      loaded_skills: [],
    })
    .returning();
  conversation_id = c!.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

function makeToolCtx(opts: {
  tenant_id: string;
  conversation_id: string;
  draft: { current: DraftDocument };
}): Parameters<typeof startWorkflowFromRecipeTool.execute>[0] {
  return {
    db: ctx.db,
    tenant_id: opts.tenant_id,
    conversation_id: opts.conversation_id,
    actor_id: null,
    getDraft: () => opts.draft.current,
    setDraft: async (next: DraftDocument) => {
      opts.draft.current = next;
    },
    // The remaining ToolContext fields aren't used by
    // start_workflow_from_recipe; we cast to satisfy the type.
  } as unknown as Parameters<typeof startWorkflowFromRecipeTool.execute>[0];
}

describe.skipIf(skip)("start_workflow_from_recipe", () => {
  test("clones a Stripe recipe into a draft with derived_from_skill_id set", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { template_slug: "stripe", recipe_slug: "list-customers" },
    );
    expect(result.ok).toBe(true);
    const wf = draft.current.workflow;
    expect(wf).toBeDefined();
    expect(wf?.derived_from_skill_id).toBe("stripe-basics");
    expect(wf?.steps?.length ?? 0).toBeGreaterThan(0);
    expect(wf?.slug).toBe("stripe-list-customers");
  });

  test("unknown template returns connector_template_unknown", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { template_slug: "made-up-template", recipe_slug: "x" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("connector_template_unknown");
  });

  test("unknown recipe lists available recipes for the template", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { template_slug: "stripe", recipe_slug: "made-up" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("connector_recipe_unknown");
      const data = result.data as { available_recipes?: string[] } | undefined;
      expect(data?.available_recipes).toContain("list-customers");
    }
  });

  test("connector_id substitution rebinds the placeholder UUID in postgres recipes", async () => {
    const realConnectorId = "11111111-1111-4111-8111-111111111111";
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      {
        template_slug: "postgres",
        recipe_slug: "list-tables",
        connector_id: realConnectorId,
      },
    );
    expect(result.ok).toBe(true);
    const step = draft.current.workflow?.steps?.[0] as { connector_id?: string } | undefined;
    expect(step?.connector_id).toBe(realConnectorId);
  });
});
