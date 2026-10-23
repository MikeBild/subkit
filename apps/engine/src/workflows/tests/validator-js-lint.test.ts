import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../validator.ts";

const workflow = (expression: string) => ({
  name: "lint fixture",
  steps: [
    { id: "list_items", kind: "request", url: "https://example.test/items", method: "GET" },
    { id: "shape", kind: "transform", language: "javascript", expression },
  ],
});

describe("validateWorkflowDef javascript lint", () => {
  const broken =
    "const day = new Date(input.input.at).toLocaleDateString('de-DE');\nreturn actionData;";

  test("authoring validation rejects free identifiers and locale APIs on the transform", () => {
    const result = validateWorkflowDef(workflow(broken), { lintJavascript: true });
    expect(result.ok).toBe(false);
    const messages = result.errors
      .filter((e) => e.path === "steps.shape.expression")
      .map((e) => e.message);
    expect(messages.some((m) => m.includes(".toLocaleDateString()") && m.includes("sk."))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes("'actionData' is not defined"))).toBe(true);
  });

  test("runtime validation without the lint flag keeps accepting stored definitions", () => {
    expect(validateWorkflowDef(workflow(broken)).ok).toBe(true);
  });

  test("a clean transform passes the lint", () => {
    const clean =
      "const rows = input.scope.list_items.data.items ?? [];\nreturn rows.map((r) => ({ id: r.id, total: sk.fmt.number(r.total, { locale: 'de', digits: 2 }) }));";
    expect(validateWorkflowDef(workflow(clean), { lintJavascript: true }).ok).toBe(true);
  });
});
