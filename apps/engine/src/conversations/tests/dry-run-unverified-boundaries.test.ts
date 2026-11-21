import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeToolCtx, type SeededToolContext } from "../../test-helpers/seed.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-unverified-bounds");
});
afterAll(async () => {
  await ctx.cleanup();
});

function toolCtx(initial: DraftDocument): SeededToolContext {
  return makeToolCtx({
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    actor_id: ctx.user_id,
    draft: initial,
  });
}

test("a bounded step skipped behind a held write is reported as unverified", async () => {
  const result = await dryRunWorkflowTool.execute(
    toolCtx({
      workflow: {
        name: "held-then-bounded",
        slug: "held-then-bounded",
        steps: [
          {
            id: "publish",
            kind: "request",
            method: "POST",
            url: "https://jsonplaceholder.typicode.com/posts",
            body: { a: 1 },
          },
          {
            id: "announce",
            kind: "request",
            method: "POST",
            url: "https://jsonplaceholder.typicode.com/comments",
            body: { id: "${scope.publish.data.id}" },
            boundary: { variables: {}, max_body_bytes: 64, max_calls: 1 },
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any),
    { input: null },
  );
  const data = result.data as {
    step_trace?: Array<{ step_id: string; status: string }>;
    unverified_boundaries?: { code: string; step_ids: string[] };
  };
  expect(data.step_trace?.find((t) => t.step_id === "announce")?.status).toBe("skipped");
  expect(data.unverified_boundaries).toMatchObject({
    code: "boundary_unverified_in_preview",
    step_ids: ["announce"],
  });
});
