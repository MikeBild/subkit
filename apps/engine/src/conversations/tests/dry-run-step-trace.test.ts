import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeToolCtx } from "../../test-helpers/seed.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-step-trace");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(getDraft: () => DraftDocument): ToolContext {
  return makeToolCtx({
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    ask_before_writing: true,
    actor_id: ctx.user_id,
    getDraft,
    setDraft: async () => {},
  });
}

describe("dry_run_workflow · step_trace envelope", () => {
  test("clean run surfaces step_trace with kind, status, duration, output_preview", async () => {
    let draft: DraftDocument = {
      workflow: {
        name: "trace-clean",
        slug: "trace-clean",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return { doubled: input.input.value * 2 };",
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any;
    const toolCtx: ToolContext = {
      ...makeCtx(() => draft),
      setDraft: async (next) => {
        draft = next;
      },
    };
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: { value: 21 } });
    expect(result.ok).toBe(true);
    const data = result.data as { step_trace?: Array<Record<string, unknown>> };
    expect(Array.isArray(data.step_trace)).toBe(true);
    expect(data.step_trace!.length).toBe(1);
    const entry = data.step_trace![0]!;
    expect(entry.step_id).toBe("shape");
    expect(entry.kind).toBe("transform");
    expect(entry.status).toBe("succeeded");
    expect(typeof entry.duration_ms).toBe("number");
    expect(entry.output_preview).toBeDefined();
    expect(entry.error_code).toBeUndefined();
    expect(entry.error).toBeUndefined();
  });

  test("step_trace preserves kind for every step in a multi-step draft (auto-committed envelope)", async () => {
    let draft: DraftDocument = {
      workflow: {
        name: "trace-multi",
        slug: "trace-multi",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return input.input;",
          },
          {
            id: "second",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.shape.data;",
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any;
    const toolCtx: ToolContext = {
      ...makeCtx(() => draft),
      setDraft: async (next) => {
        draft = next;
      },
    };
    const result = await dryRunWorkflowTool.execute(toolCtx, {
      input: { hello: "world" },
    });
    const data = result.data as {
      step_trace?: Array<Record<string, unknown>>;
      auto_committed?: boolean;
    };
    expect(data.step_trace).toBeDefined();
    expect(data.step_trace!.map((o) => o.step_id)).toEqual(["shape", "second"]);
    expect(data.step_trace!.every((o) => o.kind === "transform")).toBe(true);
    expect(data.step_trace!.every((o) => o.status === "succeeded")).toBe(true);
  });

  test("include_step_results attaches raw per-step input/output; default stays compact (D6)", async () => {
    const seed = (): DraftDocument =>
      ({
        workflow: {
          name: "d6-step-results",
          slug: "d6-step-results",
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return { doubled: input.input.value * 2 };",
            },
          ],
        },
        // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      }) as any;

    let draftA: DraftDocument = seed();
    const ctxA: ToolContext = {
      ...makeCtx(() => draftA),
      setDraft: async (next) => {
        draftA = next;
      },
    };
    const compact = await dryRunWorkflowTool.execute(ctxA, { input: { value: 21 } });
    expect((compact.data as Record<string, unknown>).step_results).toBeUndefined();

    let draftB: DraftDocument = seed();
    const ctxB: ToolContext = {
      ...makeCtx(() => draftB),
      setDraft: async (next) => {
        draftB = next;
      },
    };
    const raw = await dryRunWorkflowTool.execute(ctxB, {
      input: { value: 21 },
      include_step_results: true,
    });
    const results = (raw.data as { step_results?: Array<Record<string, unknown>> }).step_results;
    expect(Array.isArray(results)).toBe(true);
    expect(results!.length).toBe(1);
    const entry = results![0]!;
    expect(entry.step_id).toBe("shape");
    expect(entry.kind).toBe("transform");
    expect(entry.status).toBe("succeeded");
    expect("input" in entry).toBe(true);
    expect(entry.input).toBeNull();
    expect(entry.output).toBeDefined();
  });
});
