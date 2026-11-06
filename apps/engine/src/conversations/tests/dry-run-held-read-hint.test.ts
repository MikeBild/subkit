import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { makeToolCtx, type SeededToolContext } from "../../test-helpers/seed.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-held-read-hint");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(initial: DraftDocument): SeededToolContext {
  return makeToolCtx({
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    actor_id: ctx.user_id,
    draft: initial,
  });
}

function heldChainDraft(slug: string): DraftDocument {
  return {
    workflow: {
      name: slug,
      slug,
      goal: "Fetch the page and return its parsed rows.",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "POST",
          url: "https://jsonplaceholder.typicode.com/posts",
          body: { q: "rows" },
        },
        {
          id: "use",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.fetch.data;",
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

describe("dry_run_workflow · held-read nudge", () => {
  test("a held step that skips its dependents surfaces a side_effects:read hint", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "failed",
      reason: "no rows were returned",
      missing: ["the parsed rows"],
    });

    try {
      const toolCtx = makeCtx(heldChainDraft("held-read-hint"));
      const result = (await dryRunWorkflowTool.execute(toolCtx, { input: null })) as {
        ok: boolean;
        message?: string;
        data?: { held_read_hint?: string };
      };

      expect(result.ok).toBe(false);
      expect(typeof result.data?.held_read_hint).toBe("string");
      expect(result.data?.held_read_hint).toContain("side_effects");
      expect(result.message ?? "").toContain("side_effects");
    } finally {
      getMockProvider().generateOverrides = {};
    }
  });
});
