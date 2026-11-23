import { describe, expect, test } from "bun:test";
import {
  hasStoredLoopStep,
  type LoopRewriteBlockReason,
  loopRewriteMessage,
  retiredLoopNotices,
  rewriteStoredLoops,
} from "./loop-rewrite.ts";

const request = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "request",
  method: "GET",
  url: "https://example.test/${item.id}",
  ...extra,
});

const definition = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  name: "stored",
  steps,
  ...extra,
});

function blockedReason(dag: unknown): LoopRewriteBlockReason | undefined {
  return rewriteStoredLoops(dag).blocked[0]?.reason;
}

describe("rewriteStoredLoops", () => {
  test("a single-step body with a JavaScript selector moves the selector onto the body step", () => {
    const dag = definition([
      { id: "rows", kind: "transform", language: "javascript", expression: "return [];" },
      { id: "each", kind: "loop", data_selector: "(s) => s.rows.data", body: ["send"] },
      request("send"),
    ]);
    const result = rewriteStoredLoops(dag);
    expect(result.blocked).toEqual([]);
    expect(result.changes).toEqual([
      {
        loop_step_id: "each",
        body_step_id: "send",
        for_each: "(s) => s.rows.data",
        original_selector: "(s) => s.rows.data",
        selector_source: "data_selector",
      },
    ]);
    expect((result.dag as { steps: unknown[] }).steps).toEqual([
      dag.steps[0],
      { ...request("send"), for_each: "(s) => s.rows.data" },
    ]);
  });

  test("a plain `over` path becomes an arrow function and the stored input is not mutated", () => {
    const dag = definition([
      { id: "each", kind: "loop", over: " rows.data.items[0] ", body: ["send"] },
      request("send"),
    ]);
    const frozen = JSON.stringify(dag);
    const result = rewriteStoredLoops(dag);
    expect(result.changed).toBe(true);
    expect(result.changes[0]?.for_each).toBe("(sourceData) => sourceData.rows.data.items[0]");
    expect(result.changes[0]?.selector_source).toBe("over");
    expect(result.changes[0]?.original_selector).toBe(" rows.data.items[0] ");
    expect(JSON.stringify(dag)).toBe(frozen);
  });

  test("root fields other than the steps survive the rewrite", () => {
    const result = rewriteStoredLoops(
      definition([{ id: "each", kind: "loop", over: "rows", body: ["send"] }, request("send")], {
        output_transform: "$scope.send.data",
        trigger: { kind: "request" },
      }),
    );
    expect(result.dag).toMatchObject({
      name: "stored",
      output_transform: "$scope.send.data",
      trigger: { kind: "request" },
    });
  });

  test("a body with several steps is not converted and names the multi-step reason", () => {
    const dag = definition([
      { id: "each", kind: "loop", over: "rows", body: ["send", "other"] },
      request("send"),
      request("other"),
    ]);
    const result = rewriteStoredLoops(dag);
    expect(result.changed).toBe(false);
    expect(result.dag).toBe(dag);
    expect(result.blocked).toEqual([{ loop_step_id: "each", reason: "multi_step_body" }]);
  });

  test("every other obstacle has its own reason", () => {
    const loop = (extra: Record<string, unknown>) => ({ id: "each", kind: "loop", ...extra });
    expect(blockedReason(definition([loop({ over: "rows", body: [] })]))).toBe("empty_body");
    expect(blockedReason(definition([loop({ over: "rows", body: [""] })]))).toBe("empty_body");
    expect(blockedReason(definition([loop({ over: "rows" })]))).toBe("empty_body");
    expect(blockedReason(definition([loop({ over: "rows", body: ["gone"] })]))).toBe(
      "body_step_missing",
    );
    expect(blockedReason(definition([loop({ body: ["send"] }), request("send")]))).toBe(
      "no_selector",
    );
    expect(
      blockedReason(
        definition([loop({ over: "$map(rows, $string)", body: ["send"] }), request("send")]),
      ),
    ).toBe("over_not_a_path");
    expect(
      blockedReason(
        definition([
          loop({ over: "rows", body: ["send"] }),
          request("send", { for_each: "() => []" }),
        ]),
      ),
    ).toBe("body_step_has_for_each");
  });

  test("a loop whose result is read elsewhere is not converted", () => {
    const loop = { id: "each_row", kind: "loop", over: "rows", body: ["send"] };
    const reader = {
      id: "sum",
      kind: "transform",
      language: "javascript",
      expression: "return input.scope.each_row.data.length;",
    };
    expect(blockedReason(definition([loop, request("send"), reader]))).toBe(
      "loop_output_referenced",
    );
    for (const field of ["output_transform", "output_transform_function", "validation_function"])
      expect(
        blockedReason(definition([loop, request("send")], { [field]: "$scope.each_row.data" })),
      ).toBe("loop_output_referenced");
    expect(
      blockedReason(
        definition([loop, request("send")], {
          output_schema: { type: "object", properties: { each_row: {} } },
        }),
      ),
    ).toBe("loop_output_referenced");
    expect(
      rewriteStoredLoops(
        definition([loop, request("send", { url: "https://example.test/each_row/${item.id}" })]),
      ).changed,
    ).toBe(true);
  });

  test("convertible and blocked loops in one definition are reported side by side", () => {
    const result = rewriteStoredLoops(
      definition([
        { id: "ok", kind: "loop", over: "rows", body: ["send"] },
        request("send"),
        { id: "stuck", kind: "loop", over: "rows", body: ["a", "b"] },
        request("a"),
        request("b"),
      ]),
    );
    expect(result.changed).toBe(true);
    expect(result.changes.map((change) => change.loop_step_id)).toEqual(["ok"]);
    expect(result.blocked).toEqual([{ loop_step_id: "stuck", reason: "multi_step_body" }]);
    expect((result.dag as { steps: Array<{ id: string }> }).steps.map((step) => step.id)).toEqual([
      "send",
      "stuck",
      "a",
      "b",
    ]);
  });

  test("definitions without loops and malformed inputs come back untouched", () => {
    for (const dag of [null, 42, {}, { steps: "x" }, definition([request("send"), null, 7])]) {
      const result = rewriteStoredLoops(dag);
      expect(result).toEqual({ changed: false, dag, changes: [], blocked: [] });
      expect(hasStoredLoopStep(dag)).toBe(false);
    }
    expect(hasStoredLoopStep(definition([{ kind: "loop" }]))).toBe(true);
    expect(rewriteStoredLoops(definition([{ kind: "loop" }])).blocked).toEqual([]);
  });
});

describe("retired loop wording", () => {
  test("a convertible loop is told the exact for_each to set", () => {
    expect(
      retiredLoopNotices(
        definition([
          { id: "each", kind: "loop", over: "rows.data", body: ["send"] },
          request("send"),
        ]),
      ),
    ).toEqual([
      {
        loop_step_id: "each",
        message:
          'The `loop` step kind is retired. Set `for_each: "(sourceData) => sourceData.rows.data"` on step "send" and remove this step.',
      },
    ]);
  });

  test("a multi-step body is told how to rewrite it", () => {
    const [notice] = retiredLoopNotices(
      definition([{ id: "each", kind: "loop", over: "rows", body: ["a", "b"] }]),
    );
    expect(notice).toEqual({
      loop_step_id: "each",
      message: loopRewriteMessage("multi_step_body"),
    });
    expect(notice?.message).toContain("its body has more than one step");
    expect(notice?.message).toContain("`call` step that carries `for_each`");
  });

  test("every reason has its own sentence", () => {
    const reasons: LoopRewriteBlockReason[] = [
      "multi_step_body",
      "empty_body",
      "body_step_missing",
      "body_step_has_for_each",
      "no_selector",
      "over_not_a_path",
      "loop_output_referenced",
    ];
    const messages = reasons.map(loopRewriteMessage);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages)
      expect(message.startsWith("The `loop` step kind is retired")).toBe(true);
  });
});
