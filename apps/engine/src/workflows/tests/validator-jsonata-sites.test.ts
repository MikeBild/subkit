import { describe, expect, test } from "bun:test";
import {
  describeUnknownFunction,
  findUnknownFunctionCalls,
} from "../../execution/jsonata-engine.ts";
import { jsonataSiteErrors, workflowJsonataSites } from "../jsonata-sites.ts";
import { WorkflowDefSchema } from "../types.ts";
import { validateWorkflowDef } from "../validator.ts";

const FETCH = {
  id: "fetch",
  kind: "request",
  method: "GET",
  url: "https://jsonplaceholder.typicode.com/users",
};
const INDEX_OF = "$indexOf($scope.fetch.data, 1)";
const UNKNOWN_MESSAGE = describeUnknownFunction(findUnknownFunctionCalls(INDEX_OF)[0]!);

function definition(extra: Record<string, unknown>, steps: unknown[] = [FETCH]) {
  return { name: "jsonata-sites", steps, ...extra };
}

function loopDefinition(over: string) {
  return definition({}, [
    FETCH,
    { id: "each", kind: "loop", over, body: ["gate"] },
    { id: "gate", kind: "branch", when: "$item.active = true", then_steps: [] },
  ]);
}

describe("workflowJsonataSites", () => {
  test("enumerates branch.when, loop.over, output_transform and validation_expression", () => {
    const wf = WorkflowDefSchema.parse(
      definition(
        { output_transform: "$scope.fetch.data", validation_expression: "$count($) > 0" },
        [
          FETCH,
          { id: "each", kind: "loop", over: "$scope.fetch.data", body: ["gate"] },
          { id: "gate", kind: "branch", when: "$item.active = true", then_steps: [] },
        ],
      ),
    );
    expect(workflowJsonataSites(wf)).toEqual([
      { path: "steps.each.over", expression: "$scope.fetch.data" },
      { path: "steps.gate.when", expression: "$item.active = true" },
      { path: "output_transform", expression: "$scope.fetch.data" },
      { path: "validation_expression", expression: "$count($) > 0" },
    ]);
  });

  test("a `$.`-prefixed loop.over is the runtime's selector form, not a JSONata site", () => {
    const wf = WorkflowDefSchema.parse(loopDefinition("$.fetch.data"));
    expect(workflowJsonataSites(wf).map((s) => s.path)).toEqual(["steps.gate.when"]);
  });
});

describe("validateWorkflowDef · JSONata sites", () => {
  test("rejects a JavaScript method call in output_transform with the shared message", () => {
    const result = validateWorkflowDef(definition({ output_transform: INDEX_OF }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ path: "output_transform", message: UNKNOWN_MESSAGE });
  });

  test("rejects it in validation_expression", () => {
    const result = validateWorkflowDef(definition({ validation_expression: INDEX_OF }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      path: "validation_expression",
      message: UNKNOWN_MESSAGE,
    });
  });

  test("rejects it in loop.over", () => {
    const result = validateWorkflowDef(loopDefinition(INDEX_OF));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ path: "steps.each.over", message: UNKNOWN_MESSAGE });
  });

  test("compiles loop.over, output_transform and validation_expression", () => {
    const over = validateWorkflowDef(loopDefinition("$scope.fetch.data["));
    expect(over.ok).toBe(false);
    expect(over.errors.filter((e) => e.path === "steps.each.over")).toHaveLength(1);
    expect(over.errors[0]?.message).toContain("JSONata error");

    const output = validateWorkflowDef(definition({ output_transform: "$scope.fetch.data[" }));
    expect(output.errors.filter((e) => e.path === "output_transform")).toHaveLength(1);

    const validation = validateWorkflowDef(definition({ validation_expression: "$count(" }));
    expect(validation.errors.filter((e) => e.path === "validation_expression")).toHaveLength(1);
  });

  test("branch.when keeps the bare-call message and gains the unknown-function message", () => {
    const bare = validateWorkflowDef(
      definition({}, [FETCH, { id: "gate", kind: "branch", when: "not(true)", then_steps: [] }]),
    );
    expect(bare.errors).toContainEqual({
      path: "steps.gate.when",
      message: "JSONata function `not(...)` is not bound; use `$not(...)`",
    });

    const unknown = validateWorkflowDef(
      definition({}, [FETCH, { id: "gate", kind: "branch", when: "$nope(true)", then_steps: [] }]),
    );
    expect(unknown.errors).toContainEqual({
      path: "steps.gate.when",
      message: describeUnknownFunction({ name: "nope", suggestion: null }),
    });

    const broken = validateWorkflowDef(
      definition({}, [FETCH, { id: "gate", kind: "branch", when: "a > ", then_steps: [] }]),
    );
    expect(broken.ok).toBe(false);
    expect(broken.errors.filter((e) => e.path === "steps.gate.when")).toHaveLength(1);
  });

  test("accepts built-ins and := bound functions on every site", () => {
    const result = validateWorkflowDef(
      definition(
        {
          output_transform: "($f := function($x) { $x * 2 }; $map($scope.fetch.data, $f))",
          validation_expression: "$count($) >= 0",
        },
        [
          FETCH,
          {
            id: "each",
            kind: "loop",
            over: "$filter($scope.fetch.data, function($u) { $u.id > 1 })",
            body: ["gate"],
          },
          { id: "gate", kind: "branch", when: "$not($item.active)", then_steps: [] },
        ],
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("jsonataSiteErrors is the single source the validator forwards", () => {
    const raw = definition({ output_transform: INDEX_OF, validation_expression: "$count(" });
    const wf = WorkflowDefSchema.parse(raw);
    const direct = jsonataSiteErrors(wf);
    const viaValidator = validateWorkflowDef(raw).errors.filter(
      (e) => e.path === "output_transform" || e.path === "validation_expression",
    );
    expect(direct).toHaveLength(2);
    expect(viaValidator).toEqual(direct);
  });
});
