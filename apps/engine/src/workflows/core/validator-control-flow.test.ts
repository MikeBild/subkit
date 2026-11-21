import { expect, test } from "bun:test";
import { validateWorkflowDef } from "./validator.ts";

const request = { id: "fetch", kind: "request", method: "GET", url: "https://example.test" };

test("missing control-flow targets are rejected or explicitly retained as forward references", () => {
  const steps = [
    {
      id: "choose",
      kind: "branch",
      when: "true",
      then_steps: ["later_yes"],
      else_steps: ["later_no"],
    },
    { id: "parallel", kind: "parallel", branches: [["later_parallel"]] },
    { id: "loop", kind: "loop", over: "[]", body: ["later_loop"] },
  ];
  const definition = { name: "Draft", steps };
  const rejected = validateWorkflowDef(definition);
  expect(rejected.ok).toBe(false);
  expect(rejected.errors).toEqual([
    { path: "steps.choose", message: "unknown branch target: later_yes" },
    { path: "steps.choose", message: "unknown branch target: later_no" },
    { path: "steps.parallel", message: "unknown parallel target: later_parallel" },
    { path: "steps.loop", message: "unknown loop body target: later_loop" },
  ]);
  const draft = validateWorkflowDef(definition, { allowForwardRefs: true });
  expect(draft.ok).toBe(true);
  expect(draft.errors).toEqual([]);
  expect(draft.forward_refs).toEqual([
    { step_id: "choose", field: "branch.then_steps", ref: "later_yes" },
    { step_id: "choose", field: "branch.else_steps", ref: "later_no" },
    { step_id: "parallel", field: "parallel.branches", ref: "later_parallel" },
    { step_id: "loop", field: "loop.body", ref: "later_loop" },
  ]);
});

test("contained iteration steps are distinguished from unbound top-level item usage", () => {
  const leaf = { ...request, url: "https://example.test/${item.id}" };
  expect(
    validateWorkflowDef({ name: "Unbound", steps: [leaf] }).errors.some((error) =>
      error.message.includes("not contained"),
    ),
  ).toBe(true);
  for (const controller of [
    { id: "control", kind: "loop", over: "[]", body: ["fetch"] },
    { id: "control", kind: "branch", when: "true", then_steps: ["fetch"] },
    { id: "control", kind: "parallel", branches: [["fetch"]] },
  ]) {
    const result = validateWorkflowDef({ name: "Contained", steps: [controller, leaf] });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  }
});

test("duplicate identifiers, missing request addresses and invalid function bodies have actionable paths", () => {
  expect(
    validateWorkflowDef({ name: "Duplicate", steps: [request, request] }).errors,
  ).toContainEqual({ path: "steps.fetch", message: "duplicate step id" });
  expect(
    validateWorkflowDef({
      name: "Missing",
      steps: [{ id: "r", kind: "request", method: "GET", sql: { query: "select 1" } }],
    }).errors,
  ).toContainEqual({ path: "steps.r", message: "request step must specify url or connector_id" });
  const syntax = validateWorkflowDef({
    name: "Syntax",
    steps: [{ id: "broken", kind: "transform", expression: "return (" }],
  });
  expect(syntax.ok).toBe(false);
  expect(
    syntax.errors.some(
      (error) => error.path === "steps.broken.expression" && error.message.length > 0,
    ),
  ).toBe(true);
});

test("nested GraphQL and MCP argument arrays retain addressing-error paths", () => {
  for (const [field, extra] of [
    [
      "graphql.variables.rows.0.id",
      {
        graphql: {
          query: "query { viewer { id } }",
          variables: { rows: [{ id: "${scope.absent.data.id}" }, null, 1] },
        },
      },
    ],
    [
      "mcp.arguments.rows.0.id",
      {
        mcp: {
          operation: "call_tool",
          tool: "lookup",
          arguments: { rows: [{ id: "${scope.absent.data.id}" }, null, 1] },
        },
      },
    ],
  ] as const) {
    const result = validateWorkflowDef({
      name: "Nested",
      steps: [{ ...request, connector_id: "00000000-0000-4000-8000-000000000001", ...extra }],
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (error) => error.path === `steps.fetch.${field}` && error.message.includes("absent"),
      ),
    ).toBe(true);
  }
});

test("declared input properties must include every referenced top-level input key", () => {
  const definition = {
    name: "Inputs",
    input_schema: { type: "object", properties: { known: { type: "string" } } },
    steps: [{ ...request, url: "https://example.test/${input.missing}" }],
  };
  const rejected = validateWorkflowDef(definition);
  expect(rejected.errors).toContainEqual({
    path: "input_schema",
    message:
      'step references input key "missing" which is not declared in input_schema.properties — add it or remove the reference',
  });
  const accepted = validateWorkflowDef({
    ...definition,
    input_schema: { type: "object", properties: { missing: { type: "string" } } },
  });
  expect(accepted.ok).toBe(true);
});

test("connector header policies control forwarded authorization without allowing owned-header overrides", () => {
  const connector = "00000000-0000-4000-8000-000000000001";
  const definition = {
    name: "Forward",
    steps: [
      { ...request, connector_id: connector, headers: { Authorization: "Bearer forwarded" } },
    ],
  };
  const allowed = validateWorkflowDef(definition, {
    connectorHeaderPolicies: new Map([
      [connector, { allowAuthorization: true, ownedHeaders: new Set<string>() }],
    ]),
  });
  expect(allowed.ok).toBe(true);
  const owned = validateWorkflowDef(definition, {
    connectorHeaderPolicies: new Map([
      [connector, { allowAuthorization: true, ownedHeaders: new Set(["authorization"]) }],
    ]),
  });
  expect(owned.ok).toBe(false);
  expect(owned.errors.some((error) => error.path === "steps.fetch.headers.Authorization")).toBe(
    true,
  );
});
