import { expect, test } from "bun:test";
import { validateWorkflowDef } from "./validator.ts";

const request = {
  id: "fetch",
  kind: "request",
  method: "POST",
  url: "https://example.test/graphql",
  connector_id: "00000000-0000-4000-8000-000000000001",
};
const define = (step: unknown) => ({ name: "Addressing contracts", steps: [step] });

test("each MCP operation reports malformed addressing on its own public field", () => {
  for (const [operation, field] of [
    ["call_tool", "tool"],
    ["read_resource", "uri"],
    ["get_prompt", "prompt"],
  ]) {
    const result = validateWorkflowDef(
      define({
        protocol: "mcp",
        ...request,
        mcp: { operation, [field!]: "prefix/${input}/suffix" },
      }),
    );
    expect(result.errors).toEqual([
      {
        path: `steps.fetch.mcp.${field}`,
        message:
          "unresolvable placeholder `${input}`: expected ${input.<path>} — the runtime would fail this step with placeholder_unresolved",
      },
    ]);
  }
});

test("GraphQL query interpolation reports its query path independently from document syntax", () => {
  const result = validateWorkflowDef(
    define({
      protocol: "graphql",
      ...request,
      graphql: { query: "query { field(arg: ${input}) }" },
    }),
  );
  expect(result.errors).toContainEqual({
    path: "steps.fetch.graphql.query",
    message:
      "unresolvable placeholder `${input}`: expected ${input.<path>} — the runtime would fail this step with placeholder_unresolved",
  });
});

test("argument walking ignores array annotations and function properties while retaining indexed paths", () => {
  const rows = Object.assign(["${input.valid}"], { annotation: "${input}" });
  const callable = Object.assign(() => "unused", { annotation: "${input}" });
  for (const extra of [
    {
      protocol: "graphql",
      graphql: { query: "query { viewer { id } }", variables: { rows, callable } },
    },
    { protocol: "mcp", mcp: { operation: "call_tool", tool: "lookup", arguments: { rows } } },
  ]) {
    expect(validateWorkflowDef(define({ ...request, ...extra })).errors).toEqual([]);
  }
});

test("native transport blocks do not classify an unused HTTP body as their GraphQL document", () => {
  for (const extra of [
    { protocol: "graphql", graphql: { query: "query { viewer { id } }" } },
    { protocol: "sql", method: "SELECT", sql: { query: "select 1" } },
    { protocol: "mcp", mcp: { operation: "call_tool", tool: "lookup" } },
    {
      protocol: "s3",
      method: "GET",
      url: "https://example.test/graphql?query=" + encodeURIComponent("mutation { change { id } }"),
      s3: { key: "object" },
    },
  ]) {
    const result = validateWorkflowDef(
      define({
        ...request,
        ...extra,
        side_effects: "read",
        body: { query: "mutation { change { id } }" },
      }),
    );
    expect(result.errors).toEqual([]);
  }
});

test("all configured connector endpoints participate in GraphQL safety checks", () => {
  const result = validateWorkflowDef(
    define({ ...request, url: undefined, path: "/", body: {}, side_effects: "read" }),
    {
      connectorBaseUrls: new Map([
        [request.connector_id, ["https://example.test/rest", "https://example.test/graphql"]],
      ]),
    },
  );
  expect(result.errors.map((error) => error.path)).toEqual(["steps.fetch.side_effects"]);
  expect(result.errors[0]?.message).toContain("reviewed as a write");
});

test("transform syntax rejects redeclaring its input parameter, and syntax errors skip semantic lint", () => {
  const result = validateWorkflowDef({
    name: "Input binding",
    steps: [{ id: "transform", kind: "transform", expression: "let input; return input;" }],
  });
  expect(result.ok).toBe(false);
  expect(result.errors[0]?.path).toBe("steps.transform.expression");
  const broken = {
    name: "Broken",
    steps: [
      {
        id: "transform",
        kind: "transform",
        expression: 'let input; fetch("https://example.test");',
      },
    ],
  };
  expect(validateWorkflowDef(broken, { lintJavascript: true }).errors).toEqual(
    validateWorkflowDef(broken).errors,
  );
});

test("plain HTTP writes do not acquire S3-specific key requirements", () => {
  expect(
    validateWorkflowDef(define({ ...request, method: "PUT", body: "content" })).errors,
  ).toEqual([]);
});

test("workflow cycles are rejected even though every dependency names an existing step", () => {
  const result = validateWorkflowDef({
    name: "Cyclic",
    steps: [
      { ...request, id: "alpha", path: "/${scope.beta.data}" },
      { ...request, id: "beta", path: "/${scope.alpha.data}" },
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.errors[0]?.rule_id).toBe("workflow_cycle_detected");
  expect(result.errors[0]?.path).toBe("steps");
});

test("malformed GraphQL documents are rejected if any configured endpoint is GraphQL", () => {
  const result = validateWorkflowDef(
    define({ ...request, url: undefined, path: "/", body: { query: "query {" } }),
    {
      connectorBaseUrls: new Map([
        [request.connector_id, ["https://example.test/rest", "https://example.test/graphql"]],
      ]),
    },
  );
  expect(result.errors.map((error) => error.path)).toEqual(["steps.fetch.body.query"]);
});

test("plain requests do not acquire GraphQL driver requirements from connector facts", () => {
  expect(
    validateWorkflowDef(define(request), {
      connectorGraphqlTargets: new Map([[request.connector_id, [{ driver: "postgres" }]]]),
    }).errors,
  ).toEqual([]);
  const fallback = validateWorkflowDef(
    define({
      protocol: "graphql",
      ...request,
      connector_id: undefined,
      graphql: { query: "query { viewer { id } }" },
    }),
    { connectorGraphqlTargets: new Map([["", [{ driver: "postgres" }]]]) },
  );
  expect(fallback.errors.map((error) => error.path)).toEqual(["steps.fetch.graphql"]);
});

test("URL-only requests retain supplied fallback connector endpoint facts", () => {
  const result = validateWorkflowDef(
    define({
      ...request,
      connector_id: undefined,
      url: "${connector.api.base_url}",
      body: {},
      side_effects: "read",
    }),
    { connectorBaseUrls: new Map([["", ["https://example.test/graphql"]]]) },
  );
  expect(result.errors.map((error) => error.path)).toEqual(["steps.fetch.side_effects"]);
});

test("unreadable GraphQL bodies use their authored URL or path and produce one actionable error", () => {
  for (const address of [
    { url: "https://example.test/graphql" },
    { url: undefined, path: "/graphql" },
  ]) {
    const result = validateWorkflowDef(
      define({ ...request, ...address, body: {}, side_effects: "read" }),
    );
    expect(result.errors.map((error) => error.path)).toEqual(["steps.fetch.side_effects"]);
  }
  const malformed = validateWorkflowDef(
    define({ ...request, body: { query: "query {" }, side_effects: "read" }),
  );
  expect(malformed.errors.map((error) => error.path)).toEqual(["steps.fetch.body.query"]);
});

test("multiple nearby step suggestions remain individually readable", () => {
  const result = validateWorkflowDef({
    name: "Suggestions",
    steps: [
      { ...request, id: "cat" },
      { ...request, id: "bat" },
      { ...request, path: "/${scope.hat.data}" },
    ],
  });
  expect(result.errors).toEqual([
    {
      path: "steps.fetch.path",
      message:
        'placeholder `${scope.hat.data}` references unknown step "hat" — did you mean: cat, bat',
    },
  ]);
});

test("else-only branch children retain their iteration-item containment", () => {
  const result = validateWorkflowDef({
    name: "Else branch",
    steps: [
      { id: "choose", kind: "branch", when: "false", then_steps: [], else_steps: ["fetch"] },
      { ...request, body: "${item.id}" },
    ],
  });
  expect(result.errors).toEqual([]);
});

test("mixed valid and invalid GraphQL batch entries are checked against any configured endpoint", () => {
  const result = validateWorkflowDef(
    define({
      ...request,
      url: undefined,
      path: "/",
      side_effects: "write",
      body: [{ query: "query { viewer { id } }" }, { query: "query {" }],
    }),
    {
      connectorBaseUrls: new Map([
        [request.connector_id, ["https://example.test/rest", "https://example.test/graphql"]],
      ]),
    },
  );
  expect(result.errors.map((error) => error.path)).toEqual(["steps.fetch.body.query"]);
});
