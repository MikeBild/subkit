import { describe, expect, test } from "bun:test";
import { workflowInputIssues } from "./tenant-validator.ts";
import { StepSchema, WorkflowDefSchema } from "./types.ts";
import { validateWorkflowDef } from "./validator.ts";

describe("StepSchema — retired `tool` step is rejected", () => {
  test("rejects { kind: 'tool', image: 'alpine' } with a discriminator error", () => {
    const result = StepSchema.safeParse({
      kind: "tool",
      id: "x",
      image: "alpine",
      cmd: ["echo", "hi"],
    });
    expect(result.success).toBe(false);
  });

  test("the discriminated union has exactly the supported kinds", () => {
    const options = (StepSchema as unknown as { options: ReadonlyArray<unknown> }).options;
    const kinds = options
      .map((o) => {
        const shape = (o as { shape?: { kind?: { value?: string } } }).shape;
        return shape?.kind?.value ?? null;
      })
      .filter((k): k is string => typeof k === "string")
      .sort();
    expect(kinds).toEqual([
      "branch",
      "call",
      "loop",
      "parallel",
      "request",
      "transform",
      "wait",
      "wait_for_event",
    ]);
  });

  test("the supported kinds still parse", () => {
    const baseFields = { id: "x" };
    const samples: Array<Record<string, unknown>> = [
      { ...baseFields, kind: "request", url: "https://api.example.com" },
      { ...baseFields, kind: "transform", expression: "$" },
      { ...baseFields, kind: "call", workflow_slug: "other" },
      { ...baseFields, kind: "wait", duration_ms: 1000 },
      { ...baseFields, kind: "wait_for_event", event_name: "approved", timeout_ms: 60000 },
      {
        ...baseFields,
        kind: "branch",
        when: "$.x = true",
        then_steps: ["a"],
      },
      { ...baseFields, kind: "parallel", branches: [["a"], ["b"]] },
      { ...baseFields, kind: "loop", over: "$.list", body: ["b"] },
    ];
    for (const s of samples) {
      const result = StepSchema.safeParse(s);
      expect(result.success, `kind=${s.kind} should parse: ${JSON.stringify(result)}`).toBe(true);
    }
  });
});

test("GraphQL pagination accepts valid required nested connection paths", () => {
  const step = {
    kind: "request",
    id: "read",
    url: "https://api.example.com/graphql",
    graphql: {
      operation: "query",
      query:
        "query($after: String) { items(after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }",
      cursor_pagination: {
        connection_path: "items",
        cursor_variable: "after",
        items_field: "nodes",
        required_connection_paths: ["fieldValues", "details.entries"],
        max_pages: 2,
        max_items: 50,
      },
    },
  };
  const parsed = StepSchema.safeParse(step);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  if (parsed.success && parsed.data.kind === "request") {
    expect(parsed.data.graphql?.cursor_pagination?.required_connection_paths).toEqual([
      "fieldValues",
      "details.entries",
    ]);
  }
  expect(
    StepSchema.safeParse({
      ...step,
      graphql: {
        ...step.graphql,
        cursor_pagination: {
          ...step.graphql.cursor_pagination,
          required_connection_paths: ["fieldValues..pageInfo"],
        },
      },
    }).success,
  ).toBe(false);
});

test("GraphQL pagination validates the empty-read guard", () => {
  const withGuard = (guard: Record<string, unknown>) =>
    StepSchema.safeParse({
      kind: "request",
      id: "read",
      url: "https://api.example.com/graphql",
      graphql: {
        operation: "query",
        query:
          "query($after: String) { items(after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }",
        cursor_pagination: {
          connection_path: "items",
          cursor_variable: "after",
          max_pages: 2,
          max_items: 50,
          ...guard,
        },
      },
    });
  expect(withGuard({ expected_items: { min: 1 }, reread_on_empty: 2 }).success).toBe(true);
  expect(withGuard({ expected_items: { min: 1, max: 80 } }).success).toBe(true);
  expect(withGuard({ reread_on_empty: 0 }).success).toBe(true);
  const unsatisfiable = withGuard({ expected_items: { min: 5, max: 2 } });
  expect(unsatisfiable.success).toBe(false);
  expect(JSON.stringify(unsatisfiable.error?.issues)).toContain("min > max (unsatisfiable)");
  const empty = withGuard({ expected_items: {} });
  expect(empty.success).toBe(false);
  expect(JSON.stringify(empty.error?.issues)).toContain("at least one of `min` or `max`");
  expect(withGuard({ reread_on_empty: 4 }).success).toBe(false);
  expect(withGuard({ reread_on_empty: -1 }).success).toBe(false);
  expect(withGuard({ reread_on_empty: 1.5 }).success).toBe(false);
  expect(withGuard({ expected_items: { min: -1 } }).success).toBe(false);
});

describe("baseStep.for_each — W3a schema", () => {
  test("for_each is accepted on a request step (Zod parse)", () => {
    const result = StepSchema.safeParse({
      id: "fetch_item",
      kind: "request",
      method: "GET",
      url: "https://api.example.com/items/${item.id}",
      for_each: "(sourceData) => sourceData.list_items.data",
    });
    expect(result.success).toBe(true);
  });

  test("for_each is accepted on a transform step (Zod parse)", () => {
    const result = StepSchema.safeParse({
      id: "shape_item",
      kind: "transform",
      language: "javascript",
      expression: "return { id: $item.id, name: $item.name };",
      for_each: "(sourceData) => sourceData.fetch_all.data.items",
    });
    expect(result.success).toBe(true);
  });

  test("for_each is optional — steps without it still parse", () => {
    const result = StepSchema.safeParse({
      id: "plain",
      kind: "transform",
      language: "javascript",
      expression: "return 1;",
    });
    expect(result.success).toBe(true);
  });

  test("for_each coexists with data_selector (output projector) on the same step", () => {
    const result = StepSchema.safeParse({
      id: "iter_and_project",
      kind: "request",
      method: "GET",
      url: "https://api.example.com/items/${item.id}/detail",
      for_each: "(sourceData) => sourceData.fetch_projects.data",
      data_selector: "$.body.items",
    });
    expect(result.success).toBe(true);
  });
});

describe("validateWorkflowDef — E4 input_schema drift", () => {
  const BASE_REQUEST_STEP = {
    id: "fetch",
    kind: "request",
    method: "GET",
    url: "https://api.example.com/essays/${input.essay_id}",
  };

  test("accepts workflow with no input_schema (no drift check)", () => {
    const res = validateWorkflowDef({
      name: "no-schema",
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("accepts when declared properties cover all referenced keys", () => {
    const res = validateWorkflowDef({
      name: "ok",
      input_schema: {
        type: "object",
        properties: { essay_id: { type: "string" } },
      },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("rejects when step references a key absent from input_schema.properties", () => {
    const res = validateWorkflowDef({
      name: "drift",
      input_schema: {
        type: "object",
        properties: { word_count: { type: "number" } },
      },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(false);
    const messages = res.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('"essay_id"') && m.includes("not declared"))).toBe(true);
  });

  test("allows a required key that no step references (wholesale $input / JS transforms)", () => {
    const res = validateWorkflowDef({
      name: "unused-required",
      input_schema: {
        type: "object",
        properties: {
          essay_id: { type: "string" },
          unused_key: { type: "string" },
        },
        required: ["unused_key"],
      },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("non-required declared properties that are unreferenced produce no error", () => {
    const res = validateWorkflowDef({
      name: "optional-unused",
      input_schema: {
        type: "object",
        properties: {
          essay_id: { type: "string" },
          optional_extra: { type: "string" },
        },
      },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("works for multiple referenced keys — all must be declared", () => {
    const res = validateWorkflowDef({
      name: "multi-ref",
      input_schema: {
        type: "object",
        properties: {
          essay_id: { type: "string" },
        },
      },
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/essays/${input.essay_id}/by/${input.author_id}",
        },
      ],
    });
    expect(res.ok).toBe(false);
    const messages = res.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('"author_id"') && m.includes("not declared"))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('"essay_id"') && m.includes("not declared"))).toBe(
      false,
    );
  });

  test("skips drift check when input_schema has no properties key", () => {
    const res = validateWorkflowDef({
      name: "freeform",
      input_schema: { type: "object" },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });
});

describe("validateWorkflowDef — W3a retirement enforcement", () => {
  test("rejects language:'jsonata' transform step — jsonata is no longer a transform language", () => {
    const res = validateWorkflowDef({
      name: "jsonata-rejected",
      steps: [
        {
          id: "shape",
          kind: "transform",
          language: "jsonata",
          expression: "{ 'x': 1 }",
        },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  test("accepts language:'javascript' transform step", () => {
    const res = validateWorkflowDef({
      name: "js-ok",
      steps: [
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "return 1;",
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("accepts transform step with no language (defaults to javascript)", () => {
    const res = validateWorkflowDef({
      name: "default-js",
      steps: [
        {
          id: "shape",
          kind: "transform",
          expression: "return 1;",
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("accepts kind:'loop' — still valid at the validation layer for backwards compat", () => {
    const res = validateWorkflowDef({
      name: "loop-ok",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/items",
        },
        {
          id: "iter",
          kind: "loop",
          over: "$scope.fetch.data",
          body: ["process"],
        },
        {
          id: "process",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/items/${item.id}",
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("accepts a request step with for_each and $item reference", () => {
    const res = validateWorkflowDef({
      name: "for-each-ok",
      steps: [
        {
          id: "fetch_all",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/items",
        },
        {
          id: "fetch_item",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/items/${item.id}",
          for_each: "(sourceData) => sourceData.fetch_all.data",
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });
});

describe("final-output checks pick one form at the input boundary", () => {
  const steps = [{ id: "a", kind: "wait", duration_ms: 1 }];
  const rule =
    "set either `validation_expression` (JSONata) or `validation_function` (JS), not both";
  const both = {
    name: "both",
    steps,
    validation_expression: "ok = true",
    validation_function: "return input.ok === true;",
  };

  test("accepts validation_expression alone", () => {
    expect(
      workflowInputIssues({ name: "expr", steps, validation_expression: "ok = true" }),
    ).toEqual([]);
  });

  test("accepts validation_function alone", () => {
    expect(
      workflowInputIssues({ name: "fn", steps, validation_function: "return input.ok === true;" }),
    ).toEqual([]);
  });

  test("ignores input that is not an object", () => {
    expect(workflowInputIssues(null)).toEqual([]);
    expect(workflowInputIssues("workflow")).toEqual([]);
  });

  test("rejects validation_expression together with validation_function", () => {
    expect(workflowInputIssues(both)).toEqual([{ path: "validation_function", message: rule }]);
  });

  test("the rule has the same issue shape as the output transform rule", () => {
    const transform = validateWorkflowDef({
      name: "transform",
      steps,
      output_transform: "$",
      output_transform_function: "return input;",
    });
    expect(transform.ok).toBe(false);
    expect(transform.errors).toContainEqual({
      path: "output_transform_function",
      message:
        "set either `output_transform` (JSONata) or `output_transform_function` (JS), not both",
    });
    const [issue] = workflowInputIssues(both);
    const sibling = transform.errors.find((e) => e.path === "output_transform_function");
    expect(Object.keys(issue ?? {}).sort()).toEqual(Object.keys(sibling ?? {}).sort());
    expect(issue?.message).toBe(
      String(sibling?.message)
        .replace("`output_transform`", "`validation_expression`")
        .replace("`output_transform_function`", "`validation_function`"),
    );
  });

  test("a stored definition with both fields still parses", () => {
    const result = WorkflowDefSchema.safeParse(both);
    expect(result.success).toBe(true);
    expect(validateWorkflowDef(both).ok).toBe(true);
  });
});
