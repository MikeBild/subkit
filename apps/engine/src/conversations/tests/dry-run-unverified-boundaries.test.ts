// A green preview must say which declared boundaries it never reached.
//
// On a real repair the preview was green, the draft was saved and offered for
// approval — with a storage folder guessed wrong on a step the preview had
// skipped behind a held write. Nothing had said so.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x0b0d_5c1b);
let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-unverified-bounds");
});
afterAll(async () => {
  await ctx.cleanup();
});

function toolCtx(initial: DraftDocument): ToolContext {
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
  };
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
            url: "https://api.example.test/publish",
            body: { a: 1 },
          },
          {
            id: "announce",
            kind: "request",
            method: "POST",
            url: "https://api.example.test/announce",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
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
  // The fixture really skips the bounded step.
  expect(data.step_trace?.find((t) => t.step_id === "announce")?.status).toBe("skipped");
  expect(data.unverified_boundaries).toMatchObject({
    code: "boundary_unverified_in_preview",
    step_ids: ["announce"],
  });
});
