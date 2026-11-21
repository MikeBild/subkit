import { expect, test } from "bun:test";
import { validateWorkflowDef } from "../core/validator.ts";

function errorsFor(for_each: string): string[] {
  return validateWorkflowDef({
    name: "fan out",
    steps: [
      { id: "list_files", kind: "transform", expression: "return { items: [] };" },
      {
        id: "each",
        kind: "transform",
        for_each,
        expression: "return '${item.key}';",
      },
    ],
  })
    .errors.filter((error) => error.path === "steps.each.for_each")
    .map((error) => error.message);
}

test("a placeholder is not a selector", () => {
  const [message] = errorsFor("${scope.list_files.data.items}");
  expect(message).toContain("JavaScript arrow function");
  expect(message).toContain("(sourceData) => sourceData.");
});

test("a JSONata reference is not a selector", () => {
  expect(errorsFor("$list_files.data.items")).toHaveLength(1);
});

test("the documented arrow-function form is accepted", () => {
  expect(errorsFor("(sourceData) => sourceData.list_files.data.items")).toEqual([]);
});
