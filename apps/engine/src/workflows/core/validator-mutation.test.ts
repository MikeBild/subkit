// biome-ignore-all lint/suspicious/noTemplateCurlyInString: workflows intentionally contain authored substitutions
import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "./validator.ts";

const request = {
  id: "request",
  kind: "request",
  method: "GET",
  url: "https://example.test/items",
};

function messages(input: unknown, options?: Parameters<typeof validateWorkflowDef>[1]): string[] {
  return validateWorkflowDef(input, options).errors.map((error) => error.message);
}

describe("validator mutation boundaries", () => {
  test("invalid definitions retain retired-item diagnostics, schema paths, and an empty destination receipt", () => {
    const result = validateWorkflowDef(
      { name: 42, steps: [{ id: "old", kind: "loop", item_var: "item" }] },
      { destinationTier: "all" },
    );
    expect(result.ok).toBe(false);
    expect(result.placeholder_destinations).toEqual([]);
    expect(result.errors.some((error) => error.path === "steps.old.item_var")).toBe(true);
    expect(result.errors.some((error) => error.path === "name" && error.message.length > 0)).toBe(
      true,
    );
  });

  test("request address, S3 destructive shape, and selectors each reject their own invalid boundary", () => {
    const invalidUrl = messages({ name: "urls", steps: [{ ...request, url: "/relative" }] });
    expect(invalidUrl.some((message) => message.includes("url must start with http(s)://"))).toBe(
      true,
    );

    const connectorPlaceholder = validateWorkflowDef({
      name: "connector placeholder",
      steps: [{ ...request, url: "${connector.github.base_url}/v1/items" }],
    });
    expect(connectorPlaceholder.ok).toBe(true);

    const s3 = messages({
      name: "s3",
      steps: [
        {
          id: "put",
          kind: "request",
          method: "PUT",
          connector_id: "00000000-0000-4000-8000-000000000001",
          path: "archive/",
          s3: {},
        },
        {
          id: "delete",
          kind: "request",
          method: "DELETE",
          connector_id: "00000000-0000-4000-8000-000000000001",
          path: "archive/",
          s3: {},
          body: { bulk: true },
        },
      ],
    });
    expect(s3.filter((message) => message.includes("requires s3.key")).length).toBe(2);
    expect(s3.some((message) => message.includes("must not carry a body"))).toBe(true);

    const selector = messages({
      name: "selector",
      steps: [{ ...request, data_selector: "[" }],
    });
    expect(selector.some((message) => message.length > 0)).toBe(true);
  });

  test("transform syntax/lint validation is gated by a nonempty executable expression", () => {
    const syntax = messages({
      name: "syntax",
      steps: [{ id: "broken", kind: "transform", expression: "return (" }],
    });
    expect(syntax.some((message) => message.length > 0)).toBe(true);

    const empty = validateWorkflowDef({
      name: "empty transform",
      steps: [{ id: "empty", kind: "transform", expression: "" }],
    });
    expect(empty.ok).toBe(false);
    expect(empty.errors).toEqual([
      {
        path: "steps.0.expression",
        message: "transform.language=javascript requires a non-empty expression",
      },
    ]);
  });

  test("control-flow rejects missing targets, records every allowed forward reference, and requires loop item use", () => {
    const steps = [
      { id: "branch", kind: "branch", when: "true", then_steps: ["then"], else_steps: ["else"] },
      { id: "parallel", kind: "parallel", branches: [["parallel-target"]] },
      { id: "loop", kind: "loop", over: "[]", body: ["loop-target"] },
    ];
    const rejected = validateWorkflowDef({ name: "missing", steps });
    expect(rejected.errors.map((error) => error.message)).toEqual([
      "unknown branch target: then",
      "unknown branch target: else",
      "unknown parallel target: parallel-target",
      "unknown loop body target: loop-target",
    ]);
    const forward = validateWorkflowDef({ name: "missing", steps }, { allowForwardRefs: true });
    expect(forward.ok).toBe(true);
    expect(forward.forward_refs).toHaveLength(4);

    const loop = validateWorkflowDef({
      name: "loop item",
      steps: [
        { id: "each", kind: "loop", over: "[]", body: ["inside"] },
        { ...request, id: "inside" },
      ],
    });
    expect(
      loop.errors.some((error) => error.message.includes("never references the iteration item")),
    ).toBe(true);
    const item = validateWorkflowDef({
      name: "loop item",
      steps: [
        { id: "each", kind: "loop", over: "[]", body: ["inside"] },
        { ...request, id: "inside", url: "https://example.test/${item.id}" },
      ],
    });
    expect(item.ok).toBe(true);
  });

  test("schema declarations, GraphQL-over-HTTP safety, and placeholder traversals reject unsafe claims", () => {
    const input = validateWorkflowDef({
      name: "inputs",
      input_schema: { type: "object", properties: { declared: { type: "string" } } },
      steps: [{ ...request, url: "https://example.test/${input.missing}" }],
    });
    expect(input.errors.some((error) => error.message.includes('input key "missing"'))).toBe(true);

    const graphql = validateWorkflowDef({
      name: "graphql",
      steps: [
        {
          ...request,
          method: "POST",
          side_effects: "read",
          body: { query: "mutation Change { changeThing { id } }" },
        },
      ],
    });
    expect(graphql.errors.some((error) => error.message.includes("GraphQL mutation"))).toBe(true);

    const unknown = validateWorkflowDef({
      name: "unknown placeholder",
      steps: [{ ...request, url: "https://example.test/${scope.absent.data.id}" }],
    });
    expect(unknown.errors.some((error) => error.path === "steps.request.url")).toBe(true);
  });

  test("a valid definition with a placeholder destination is rejected and lists the destination", () => {
    const result = validateWorkflowDef(
      {
        name: "placeholder destination",
        steps: [{ ...request, method: "POST", body: { to: "REPLACE_ME" } }],
      },
      { destinationTier: "all" },
    );
    expect(result.ok).toBe(false);
    expect(result.placeholder_destinations?.length).toBeGreaterThan(0);
    expect(result.errors.length).toBeGreaterThan(0);

    const clean = validateWorkflowDef(
      { name: "clean destination", steps: [request] },
      { destinationTier: "tokens" },
    );
    expect(clean.ok).toBe(true);
    expect(clean.placeholder_destinations).toEqual([]);
  });
});
