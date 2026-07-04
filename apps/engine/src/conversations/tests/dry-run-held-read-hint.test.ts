// dry_run_workflow · held-read nudge.
//
// When a dry-run holds a step (write-classified by default) and that hold
// SKIPS the step's dependents, the held step is often a READ misclassified as a
// write — e.g. a browserless scrape that uses POST. The keyed benchmark showed
// the model burning previews before it set side_effects:read. On a non-green
// preview where holding skipped dependents, the dry-run now surfaces a
// `held_read_hint` (and folds it into the message) telling the author to set
// side_effects:read if the held step only reads. It is a NUDGE only — the
// engine never auto-reclassifies a POST (which can be a genuine write).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x4e1d_5ead);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-held-read-hint");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(initial: DraftDocument): ToolContext & { current: () => DraftDocument } {
  let draft = initial;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: uuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
    current: () => draft,
  };
}

// fetch (POST request, HELD by default) → use (transform reading the held step
// via input.scope.fetch → skipped_dependency_held). A goal is stashed so the
// judge runs; the judge fails (output incomplete because the POST was held) →
// the preview is NOT clean → the held-read nudge surfaces.
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
          url: "https://example.test/scrape",
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
    // Judge fails unconditionally — the preview cannot satisfy the goal because
    // the POST was held, so its dependent produced no rows.
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
      // The structured hint is present on the envelope...
      expect(typeof result.data?.held_read_hint).toBe("string");
      expect(result.data?.held_read_hint).toContain("side_effects");
      // ...and folded into the top-level message the log/model read.
      expect(result.message ?? "").toContain("side_effects");
    } finally {
      getMockProvider().generateOverrides = {};
    }
  });
});
