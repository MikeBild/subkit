// User story: As an operator, I want loop steps to actually iterate over
// each item in a collection, so that I can process lists of items inside
// a workflow without writing N separate request steps.
//
// Acceptance criteria:
//   - AC1: The loop body runs once per item in the collection.
//   - AC2: The `item_var` binding is accessible inside the body step scope.
//   - AC3: `$loop_index` is injected and increments correctly.
//   - AC4: Body steps are skipped in the linear walk (not double-executed).
//   - AC5: Workflow status is "succeeded" when all iterations complete.
// Spec refs: plan docs — §2e LOOP STEP: Actual Item Iteration

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

beforeAll(async () => {
  ctx = await createJourneyCtx("loop-iteration");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
});

describe("47: Loop step — iterates items, injects item_var and $loop_index", () => {
  test("AC1+AC2+AC5: body runs once per item, item_var accessible, status succeeded", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "loop-double",
        slug: "loop-double",
        steps: [
          // Produces the collection to iterate.
          {
            kind: "transform",
            id: "get_numbers",
            expression: "[1, 2, 3]",
          },
          // Loop over the collection; body step runs for each item.
          {
            kind: "loop",
            id: "process_numbers",
            over: "get_numbers.data",
            item_var: "num",
            body: ["double_num"],
          },
          // Body step: doubles the current item.
          {
            kind: "transform",
            id: "double_num",
            expression: "num * 2",
          },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, `/v1/workflows/${wf.id}/run?sync=1`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.status).toBe(200);
    const body = (await runRes.json()) as {
      status: string;
      output: unknown;
      steps: Array<{ step_key: string; status: string }>;
    };

    expect(body.status).toBe("succeeded");

    // Loop output is an array of per-iteration body results.
    const loopOutput = body.output as Array<Record<string, number>>;
    expect(Array.isArray(loopOutput)).toBe(true);
    expect(loopOutput).toHaveLength(3);
    expect((loopOutput[0]?.double_num as { data: number } | undefined)?.data).toBe(2);
    expect((loopOutput[1]?.double_num as { data: number } | undefined)?.data).toBe(4);
    expect((loopOutput[2]?.double_num as { data: number } | undefined)?.data).toBe(6);
  });

  test("AC3: $loop_index increments per iteration", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "loop-index",
        slug: "loop-index",
        steps: [
          {
            kind: "transform",
            id: "get_items",
            expression: "['a', 'b', 'c']",
          },
          {
            kind: "loop",
            id: "tag_items",
            over: "get_items.data",
            item_var: "letter",
            body: ["build_tag"],
          },
          {
            kind: "transform",
            id: "build_tag",
            // Produces { index: 0|1|2, letter: "a"|"b"|"c" }
            expression: "{ 'index': $loop_index, 'letter': letter }",
          },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, `/v1/workflows/${wf.id}/run?sync=1`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { output: unknown };
    const out = runBody.output as Array<{
      build_tag: { data: { index: number; letter: string } };
    }>;
    expect(out[0]?.build_tag?.data?.index).toBe(0);
    expect(out[1]?.build_tag?.data?.index).toBe(1);
    expect(out[2]?.build_tag?.data?.index).toBe(2);
  });

  test("AC4: body step is skipped in linear walk (not double-executed)", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "loop-no-double",
        slug: "loop-no-double",
        steps: [
          { kind: "transform", id: "get_items", expression: "[10, 20]" },
          {
            kind: "loop",
            id: "process_items",
            over: "get_items.data",
            item_var: "val",
            body: ["halve"],
          },
          { kind: "transform", id: "halve", expression: "val / 2" },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, `/v1/workflows/${wf.id}/run?sync=1`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      steps: Array<{ step_key: string; status: string }>;
    };

    // "halve" step should appear as skipped (aborted) in the linear walk,
    // not as "succeeded" — it was already handled inside the loop body.
    const halveLinear = runBody.steps.find((s) => s.step_key === "halve");
    expect(halveLinear?.status).toBe("aborted");
  });
});
