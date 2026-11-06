import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getMockProvider, resetMockProvider } from "../../../llm/mock-provider.ts";
import { makeToolCtx, type SeededToolContext } from "../../../test-helpers/seed.ts";
import { proposeDryRunRepairs, workflowOutputSite } from "../../dry-run-repair.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import { dryRunWorkflowTool } from "../dry-run-workflow.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-output-fn");
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

function makeCtx(initial: DraftDocument): SeededToolContext {
  return makeToolCtx({
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    actor_id: ctx.user_id,
    draft: initial,
  });
}

const ROWS = [{ a: 1 }, { a: 2 }];
const ROWS_STEP = {
  id: "make_rows",
  kind: "transform",
  language: "javascript",
  expression: "return [{ a: 1 }, { a: 2 }];",
};

function draft(
  slug: string,
  extra: Record<string, unknown>,
  steps: unknown[] = [ROWS_STEP],
): DraftDocument {
  return { workflow: { name: slug, slug, steps, ...extra } } as unknown as DraftDocument;
}

async function preview(document: DraftDocument) {
  const toolCtx = makeCtx(document);
  const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
  return { toolCtx, result, data: result.data as { final_output?: unknown } };
}

describe("dry_run_workflow · the preview runs the validated definition, nothing re-added", () => {
  test("output_transform_function shapes final_output from the last step's data", async () => {
    const { toolCtx, result, data } = await preview(
      draft("output-fn", {
        output_transform_function: "return { rows: input, row_count: input.length };",
      }),
    );
    expect(result.ok).toBe(true);
    expect(data.final_output).toEqual({ rows: ROWS, row_count: 2 });
    expect(toolCtx.draft.latest_preview?.preview).toEqual({ rows: ROWS, row_count: 2 });
  });

  test("validation_expression gates the preview", async () => {
    const failing = await preview(
      draft("validation-expr-fails", { validation_expression: "$count($) = 3" }),
    );
    expect(failing.result.ok).toBe(false);
    const passing = await preview(
      draft("validation-expr-passes", { validation_expression: "$count($) = 2" }),
    );
    expect(passing.result.ok).toBe(true);
  });

  test("validation_function gates the preview with the final value as `input`", async () => {
    const failing = await preview(
      draft("validation-fn-fails", { validation_function: "return input.length === 3;" }),
    );
    expect(failing.result.ok).toBe(false);
    const passing = await preview(
      draft("validation-fn-passes", { validation_function: "return input.length === 2;" }),
    );
    expect(passing.result.ok).toBe(true);
  });

  test("response_filters strip the final output", async () => {
    const { result, data } = await preview(
      draft(
        "filters",
        { response_filters: [{ target: "KEYS", action: "REMOVE", pattern: "^secret$" }] },
        [
          {
            id: "make_row",
            kind: "transform",
            language: "javascript",
            expression: "return { keep: 1, secret: 'x' };",
          },
        ],
      ),
    );
    expect(result.ok).toBe(true);
    expect(data.final_output).toEqual({ keep: 1 });
  });
});

describe("proposeDryRunRepairs · workflow output site", () => {
  const previewScope = { make_rows: { data: ROWS, duration_ms: 1, error: null } };
  const runError = { code: "output_transform_failed", message: "output_transform threw" };

  function repairPrompt(): string {
    return getMockProvider().calls.find((c) => c.flow === "repair")?.last_user ?? "";
  }

  test("workflowOutputSite derives site, language and expression from the definition", () => {
    expect(workflowOutputSite({})).toBeNull();
    expect(workflowOutputSite({ output_transform: "$.a" })).toEqual({
      site: "output_transform",
      language: "jsonata",
      expression: "$.a",
    });
    expect(workflowOutputSite({ output_transform_function: "return input;" })).toEqual({
      site: "output_transform_function",
      language: "javascript",
      expression: "return input;",
    });
  });

  test("a JSONata output_transform is repaired as JSONata", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: "$scope.make_rows.data" });
    const proposals = await proposeDryRunRepairs({
      steps: [ROWS_STEP],
      runWarnings: [],
      runError,
      output: workflowOutputSite({ output_transform: "$indexOf($scope.make_rows.data, 1)" }),
      outputEvaluation: {
        kind: "workflow_output",
        root: ROWS,
        scope: previewScope,
        input: null,
        output_schema: null,
      },
      previewScope,
      input: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      step_id: null,
      site: "output_transform",
      repair: { repaired: true, after: "$scope.make_rows.data" },
    });
    expect(repairPrompt()).toContain("A JSONata `output_transform` in a workflow draft failed.");
    expect(repairPrompt()).not.toContain("FUNCTION BODY");
  });

  test("a JavaScript output_transform_function receives a proposal under its own contract", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: "return { rows: input };" });
    const proposals = await proposeDryRunRepairs({
      steps: [ROWS_STEP],
      runWarnings: [],
      runError,
      output: workflowOutputSite({
        output_transform_function: "return { rows: input.scope.make_rows.data };",
      }),
      outputEvaluation: {
        kind: "workflow_output",
        root: ROWS,
        scope: previewScope,
        input: null,
        output_schema: null,
      },
      previewScope,
      input: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });
    expect(proposals[0]).toMatchObject({
      step_id: null,
      site: "output_transform_function",
      repair: { repaired: true, after: "return { rows: input };" },
    });
    expect(repairPrompt()).toContain(
      "A JavaScript `output_transform_function` in a workflow draft failed.",
    );
    expect(repairPrompt()).toContain("There is NO `input.scope` and NO `input.input` here");
  });

  test("without an output site there is no output proposal", async () => {
    const proposals = await proposeDryRunRepairs({
      steps: [ROWS_STEP],
      runWarnings: [],
      runError,
      output: null,
      outputEvaluation: null,
      previewScope,
      input: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });
    expect(proposals).toEqual([]);
    expect(getMockProvider().calls).toHaveLength(0);
  });
});
