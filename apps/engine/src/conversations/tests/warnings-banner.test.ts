// `warnings_banner` on dry_run_workflow + run_workflow envelopes.
// Promotes the warnings list to a top-level summary so the LLM sees
// `count + codes + entries` immediately on result.data, instead of
// scrolling past `step_trace` to find them. Pre-fix the LLM in
// session ebd66982 read the trace top-down, missed the
// `loop_over_unresolved` warnings on three consecutive dry-runs,
// and burned the step budget guessing path variants.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x4ab1_e2bba);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("warnings-banner");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(getDraft: () => DraftDocument): ToolContext {
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
    getDraft,
    setDraft: async () => {},
  };
}

describe("dry_run_workflow · warnings_banner", () => {
  test("loop_over_unresolved produces a top-level warnings_banner", async () => {
    // Reproduce session ebd66982: an upstream step succeeds, a
    // loop reads `$scope.<existing>.data.<bad_field>` (the path
    // refers to a real step but the field doesn't exist), the
    // engine emits a `loop_over_unresolved` warning at runtime.
    // (Authoring-time `validateStepReferences` only catches an
    // unknown step id; an unknown sub-field is the runtime case.)
    // Pre-fix the warning landed nested inside `data.warnings`.
    // Post-fix the banner surfaces at the top of `result.data`.
    const draft: DraftDocument = {
      workflow: {
        name: "warnings-banner-loop",
        slug: "warnings-banner-loop",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return { ok: true };",
          },
          {
            id: "iter",
            kind: "loop",
            // shape.data is `{ok: true}` — `bad_field` is undefined.
            over: "$scope.shape.data.bad_field",
            body: ["body"],
          },
          {
            id: "body",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.$item;",
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fixture
    } as any;
    const result = await dryRunWorkflowTool.execute(
      makeCtx(() => draft),
      { input: null },
    );
    const data = result.data as {
      warnings_banner?: {
        count: number;
        codes: string[];
        summary: string;
        entries: Array<{ code: string }>;
      };
      warnings?: Array<{ code: string }>;
    };
    expect(data.warnings_banner).toBeDefined();
    expect(data.warnings_banner!.count).toBeGreaterThan(0);
    expect(data.warnings_banner!.codes).toContain("loop_over_unresolved");
    expect(data.warnings_banner!.summary).toContain("loop_over_unresolved");
    // The legacy nested `warnings` field stays for back-compat.
    expect(data.warnings).toBeDefined();
  });

  test("clean run has no warnings_banner field at all", async () => {
    const draft: DraftDocument = {
      workflow: {
        name: "warnings-banner-clean",
        slug: "warnings-banner-clean",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return { ok: true };",
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fixture
    } as any;
    const result = await dryRunWorkflowTool.execute(
      makeCtx(() => draft),
      { input: null },
    );
    const data = result.data as { warnings_banner?: unknown; warnings?: unknown };
    expect(data.warnings_banner).toBeUndefined();
    expect(data.warnings).toBeUndefined();
  });

  test("warnings_banner.codes is sorted + deduped", async () => {
    // Single loop step with a missing-FIELD reference (shape.data.bad
    // is undefined at runtime) produces ONE warning code,
    // regardless of how many times it surfaces.
    const draft: DraftDocument = {
      workflow: {
        name: "warnings-banner-dedup",
        slug: "warnings-banner-dedup",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return { ok: true };",
          },
          {
            id: "iter",
            kind: "loop",
            over: "$scope.shape.data.nonexistent",
            body: ["body"],
          },
          {
            id: "body",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.$item;",
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fixture
    } as any;
    const result = await dryRunWorkflowTool.execute(
      makeCtx(() => draft),
      { input: null },
    );
    const data = result.data as { warnings_banner?: { codes: string[] } };
    if (data.warnings_banner) {
      const codes = data.warnings_banner.codes;
      const sorted = [...codes].sort();
      expect(codes).toEqual(sorted);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });
});
