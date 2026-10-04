import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import { summarizeToolFailure } from "../tools/sdk-wrap/policy-helpers.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0xfa11_03);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-failure-surfacing");
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

function failingDraft(slug: string): DraftDocument {
  return {
    workflow: {
      name: slug,
      slug,
      steps: [
        {
          id: "boom",
          kind: "transform",
          language: "javascript",
          expression: "throw new Error('intentional step failure');",
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

describe("dry_run_workflow · failure surfacing", () => {
  test("the failure names the step that failed, not one skipped behind a held write", async () => {
    const toolCtx = makeCtx({
      workflow: {
        name: "held-then-failed",
        slug: "held-then-failed",
        steps: [
          {
            id: "publish",
            kind: "request",
            method: "POST",
            url: "https://api.example.test/publish",
            body: { a: 1 },
          },
          {
            id: "after_publish",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.publish.data;",
          },
          {
            id: "boom",
            kind: "transform",
            language: "javascript",
            expression: "throw new Error('intentional step failure');",
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any);
    const result = (await dryRunWorkflowTool.execute(toolCtx, { input: null })) as {
      ok: boolean;
      message?: string;
      data?: { step_trace?: Array<{ step_id: string; status: string }> };
    };
    expect(result.ok).toBe(false);
    const trace = result.data?.step_trace ?? [];
    expect(trace.find((t) => t.step_id === "after_publish")?.status).toBe("skipped");
    expect(result.message).toContain("`boom`");
    expect(result.message).not.toContain("`after_publish`");
    expect(result.message).toContain("intentional step failure");
  });

  test("a failed dry-run returns ok:false with a top-level error_code + message", async () => {
    const toolCtx = makeCtx(failingDraft("dry-run-failure-surfacing-step"));
    const result = (await dryRunWorkflowTool.execute(toolCtx, { input: null })) as {
      ok: boolean;
      error_code?: string;
      message?: string;
    };

    expect(result.ok).toBe(false);
    expect(typeof result.error_code).toBe("string");
    expect((result.error_code ?? "").length).toBeGreaterThan(0);
    expect(typeof result.message).toBe("string");
    expect((result.message ?? "").length).toBeGreaterThan(0);
  });

  test("summarizeToolFailure lifts that reason into the log (no more `undefined`)", async () => {
    const toolCtx = makeCtx(failingDraft("dry-run-failure-surfacing-log"));
    const result = (await dryRunWorkflowTool.execute(toolCtx, { input: null })) as {
      ok: boolean;
      error_code?: string;
      message?: string;
      data?: unknown;
    };

    const summary = summarizeToolFailure(result);
    expect(typeof summary.error_code).toBe("string");
    expect((summary.error_code ?? "").length).toBeGreaterThan(0);
    expect(typeof summary.error).toBe("string");
    expect((summary.error ?? "").length).toBeGreaterThan(0);
  });
});
