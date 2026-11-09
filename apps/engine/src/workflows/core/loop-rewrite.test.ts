import { describe, expect, test } from "bun:test";
import type { DomainStepDef, DomainWorkflowDef } from "../domain-types.ts";
import { rewriteLoopsToForEachDomain } from "./loop-rewrite.ts";

function definition(
  steps: DomainStepDef[],
  extras: Partial<DomainWorkflowDef> = {},
): DomainWorkflowDef {
  return { name: "rewrite", steps, ...extras };
}

const request = (id: string, extras: Partial<Extract<DomainStepDef, { kind: "request" }>> = {}) =>
  ({ id, kind: "request", url: "https://example.test", ...extras }) as const;

describe("rewriteLoopsToForEachDomain", () => {
  test("keeps definitions without loops referentially unchanged", () => {
    const def = definition([request("request")]);
    expect(rewriteLoopsToForEachDomain(def)).toEqual({
      ok: true,
      changed: false,
      def,
      changes: [],
    });
  });

  test("rewrites an eligible data selector and leaves its input untouched", () => {
    const def = definition([
      {
        id: "loop",
        kind: "loop",
        data_selector: "(sourceData) => sourceData.rows",
        body: ["request"],
      },
      request("request"),
    ]);
    const result = rewriteLoopsToForEachDomain(def);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      changes: [
        {
          loop_step_id: "loop",
          body_step_id: "request",
          for_each: "(sourceData) => sourceData.rows",
          selector_source: "data_selector",
        },
      ],
    });
    if (!result.ok || !result.changed) return;
    expect(result.def.steps).toEqual([
      request("request", { for_each: "(sourceData) => sourceData.rows" }),
    ]);
    expect(def.steps).toHaveLength(2);
  });

  test("converts only plain dot-path over selectors", () => {
    const eligible = definition([
      { id: "loop", kind: "loop", over: "payload.rows[0]", body: ["request"] },
      request("request"),
    ]);
    const complex = definition([
      { id: "loop", kind: "loop", over: "$map(rows, $string)", body: ["request"] },
      request("request"),
    ]);
    expect(rewriteLoopsToForEachDomain(eligible)).toMatchObject({
      ok: true,
      changed: true,
      changes: [
        { for_each: "(sourceData) => sourceData.payload.rows[0]", selector_source: "over" },
      ],
    });
    expect(rewriteLoopsToForEachDomain(complex)).toMatchObject({ ok: true, changed: false });
  });

  test("rejects a dangling eligible loop body and otherwise skips unsafe loops", () => {
    const dangling = definition([
      { id: "loop", kind: "loop", over: "rows", body: ["gone"] },
      request("request"),
    ]);
    expect(rewriteLoopsToForEachDomain(dangling)).toEqual({
      ok: false,
      reason: 'loop body step "gone" not found in workflow steps',
      loop_step_id: "loop",
    });

    for (const def of [
      definition([
        { id: "loop", kind: "loop", over: "rows", body: ["request", "other"] },
        request("request"),
        request("other"),
      ]),
      definition([{ id: "loop", kind: "loop", body: ["request"] }, request("request")]),
      definition([
        { id: "loop", kind: "loop", over: "rows", body: ["request"] },
        request("request", { for_each: "already" }),
      ]),
      definition([
        { id: "loop", kind: "loop", over: "rows", body: ["request"] },
        request("request"),
        { id: "uses-loop", kind: "transform", expression: "return input.scope.loop;" },
      ]),
      definition(
        [{ id: "loop", kind: "loop", over: "rows", body: ["request"] }, request("request")],
        { output_transform: "$loop" },
      ),
    ])
      expect(rewriteLoopsToForEachDomain(def)).toMatchObject({ ok: true, changed: false });
  });

  test("rewrites eligible loops independently and preserves ineligible loops", () => {
    const result = rewriteLoopsToForEachDomain(
      definition([
        { id: "eligible", kind: "loop", over: "rows", body: ["request"] },
        request("request"),
        { id: "kept", kind: "loop", over: "$map(rows, $string)", body: ["other"] },
        request("other"),
      ]),
    );
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      changes: [{ loop_step_id: "eligible" }],
    });
    if (!result.ok || !result.changed) return;
    expect(result.def.steps.map((step) => step.id)).toEqual(["request", "kept", "other"]);
  });
});

test("dot-path rewriting trims selectors but retains the exact original for review", () => {
  const over = " payload.rows[12].items ";
  expect(
    rewriteLoopsToForEachDomain(
      definition([{ id: "loop", kind: "loop", over, body: ["request"] }, request("request")]),
    ),
  ).toMatchObject({
    ok: true,
    changed: true,
    changes: [
      {
        for_each: "(sourceData) => sourceData.payload.rows[12].items",
        original_selector: over,
        selector_source: "over",
      },
    ],
  });
  for (const over of ["!rows", "rows!", "rows[12]!"])
    expect(
      rewriteLoopsToForEachDomain(
        definition([{ id: "loop", kind: "loop", over, body: ["request"] }, request("request")]),
      ),
    ).toMatchObject({ ok: true, changed: false });
});
test("empty body identities and root references are not rewritten", () => {
  expect(
    rewriteLoopsToForEachDomain(
      definition([{ id: "loop", kind: "loop", over: "rows", body: [""] }, request("request")]),
    ),
  ).toMatchObject({ ok: true, changed: false });
  for (const extras of [
    { output_transform: "loop" },
    { output_transform_function: "loop" },
    { validation_function: "loop" },
    { output_schema: { description: "loop" } },
  ])
    expect(
      rewriteLoopsToForEachDomain(
        definition(
          [{ id: "loop", kind: "loop", over: "rows", body: ["request"] }, request("request")],
          extras,
        ),
      ),
    ).toMatchObject({ ok: true, changed: false });
});

test("reference scanning preserves separators while omitting absent root fields", () => {
  const build = (id: string) => [
    { id, kind: "loop" as const, over: "rows", body: ["request"] },
    request("request"),
  ];
  expect(
    rewriteLoopsToForEachDomain(definition(build("loop\0"), { output_transform: "loop" })),
  ).toMatchObject({ ok: true, changed: true });
  expect(
    rewriteLoopsToForEachDomain(
      definition(build("loop\0tail"), {
        output_transform: "loop",
        output_transform_function: "tail",
      }),
    ),
  ).toMatchObject({ ok: true, changed: false });
});
