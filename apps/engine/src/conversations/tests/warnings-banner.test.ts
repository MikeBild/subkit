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
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
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
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
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
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
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
