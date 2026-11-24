import { expect, test } from "bun:test";
import { validateWorkflowDef } from "./validator.ts";

const connector = "00000000-0000-4000-8000-000000000001";
const request = { id: "fetch", kind: "request", method: "GET", url: "https://example.test" };
const define = (steps: unknown[]) => ({ name: "Boundary contracts", steps });

test("schema failures retain numeric paths, original messages and unnamed retired-loop locations", () => {
  const result = validateWorkflowDef(define([{ kind: "loop", item_var: "old" }]));
  expect(result.ok).toBe(false);
  expect(result.errors.find((error) => error.path === "steps.0.item_var")?.message).toContain(
    "retired",
  );
  expect(result.errors).toContainEqual({
    path: "steps.0.id",
    message: "Invalid input: expected string, received undefined",
  });
  expect(result).not.toHaveProperty("placeholder_destinations");
});

test("absolute URLs and connector URLs must start at the beginning of the address", () => {
  for (const url of ["http://example.test", "https://example.test", "${connector.a.base_url}"]) {
    expect(validateWorkflowDef(define([{ ...request, url }])).errors).toEqual([]);
  }
  for (const url of ["prefix https://example.test", "prefix ${connector.a.base_url}/x"]) {
    expect(validateWorkflowDef(define([{ ...request, url }])).errors).toEqual([
      {
        path: "steps.fetch.url",
        message:
          "url must start with http(s):// OR with `${connector.<slug>.base_url}` — alternatively set `connector_id` and `path` so the driver merges base_url + path",
      },
    ]);
  }
});

test("only leading legacy references reject a for_each selector, with surrounding whitespace ignored", () => {
  for (const for_each of ["  $scope.fetch.data ", "  ${input.items} "]) {
    expect(
      validateWorkflowDef(define([{ ...request, for_each }])).errors.map((error) => error.path),
    ).toEqual(["steps.fetch.for_each"]);
  }
  const valid = validateWorkflowDef(
    define([{ ...request, for_each: "(sourceData) => sourceData.$items" }]),
  );
  expect(valid.errors).toEqual([]);
});

test("known branch targets do not become forward references and mixed loops defer item requirements", () => {
  const known = validateWorkflowDef(
    define([
      { id: "choose", kind: "branch", when: "true", then_steps: [], else_steps: ["fetch"] },
      request,
    ]),
  );
  expect(known.errors).toEqual([]);
  expect(known).not.toHaveProperty("forward_refs");
  const mixed = validateWorkflowDef(
    define([{ id: "each", kind: "loop", over: "[]", body: ["fetch", "later"] }, request]),
    { allowForwardRefs: true },
  );
  expect(mixed.errors).toEqual([]);
  expect(mixed.forward_refs).toEqual([{ step_id: "each", field: "loop.body", ref: "later" }]);
  const item = validateWorkflowDef(
    define([
      { id: "each", kind: "loop", over: "[]", body: ["fetch", "use_item"] },
      request,
      { ...request, id: "use_item", url: "https://example.test/${item.id}" },
    ]),
  );
  expect(item.errors).toEqual([]);
});

test("S3 optional body and object-key boundaries distinguish read, put and delete", () => {
  for (const body of [undefined, null]) {
    const result = validateWorkflowDef(
      define([{ ...request, method: "DELETE", connector_id: connector, s3: { key: "a" }, body }]),
    );
    expect(result.errors).toEqual([]);
  }
  const put = validateWorkflowDef(
    define([
      {
        ...request,
        method: "PUT",
        connector_id: connector,
        path: "archive/",
        s3: {},
        body: "data",
      },
    ]),
  );
  expect(put.errors).toEqual([
    {
      path: "steps.fetch.s3.key",
      message:
        "s3 PUT requires s3.key — step.path is not an object key. To act on many objects, use for_each over the keys with s3.key set per item.",
    },
  ]);
});

test("malformed addressing tokens report only their exact source slice and full destination path", () => {
  const result = validateWorkflowDef(
    define([
      {
        ...request,
        connector_id: connector,
        path: "archive/",
        s3: { prefix: "prefix/${input}/suffix" },
      },
    ]),
  );
  expect(result.errors).toEqual([
    {
      path: "steps.fetch.s3.prefix",
      message:
        "unresolvable placeholder `${input}`: expected ${input.<path>} — the runtime would fail this step with placeholder_unresolved",
    },
  ]);
  const unknown = validateWorkflowDef(define([{ ...request, path: "/${scope.zzzzzzzz.data}" }]));
  expect(unknown.errors).toEqual([
    {
      path: "steps.fetch.path",
      message: 'placeholder `${scope.zzzzzzzz.data}` references unknown step "zzzzzzzz"',
    },
  ]);
});

test("GraphQL subscriptions cannot claim read effects, but write-labelled mutations remain valid", () => {
  for (const [query, side_effects, accepted] of [
    ["subscription { updated { id } }", "read", false],
    ["mutation { update { id } }", "write", true],
    ["query { viewer { id } }", "read", true],
  ] as const) {
    const result = validateWorkflowDef(
      define([
        {
          ...request,
          method: "POST",
          url: "https://example.test/graphql",
          body: { query },
          side_effects,
        },
      ]),
    );
    expect(result.ok).toBe(accepted);
    expect(result.errors).toEqual(
      accepted
        ? []
        : [
            {
              path: "steps.fetch.side_effects",
              message:
                'body.query is a GraphQL subscription, which changes data; a subscription cannot be declared side_effects "read". Remove the label or send a query document.',
            },
          ],
    );
  }
});

test("GraphQL batches containing dynamic documents defer classification until substitution", () => {
  for (const body of [
    [{ query: "${input.document}" }, { extensions: { persistedQuery: { sha256Hash: "abc" } } }],
    [{ query: "query { viewer { id } }" }, { query: "${input.document}" }],
  ]) {
    const result = validateWorkflowDef(
      define([
        {
          ...request,
          method: "POST",
          url: "https://example.test/graphql",
          body,
          side_effects: "read",
        },
      ]),
    );
    expect(result.errors).toEqual([]);
  }
});

test("unbound item placeholders in payloads retain their step path and whitespace detection", () => {
  const result = validateWorkflowDef(define([{ ...request, body: "${ item.id}" }]));
  expect(result.ok).toBe(false);
  expect(result.errors.map((error) => error.path)).toEqual(["steps.fetch"]);
  expect(result.errors[0]?.message).toContain("not contained");
});

test("invalid properties shapes produce only the schema diagnostic, not invented undeclared input keys", () => {
  for (const properties of [null, "not properties", 42, [], ["unexpected"]]) {
    const result = validateWorkflowDef({
      ...define([{ ...request, body: "${input.missing}" }]),
      input_schema: { type: "object", properties },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("input_schema");
    expect(result.errors[0]?.message).toStartWith("input_schema is not a valid JSON Schema:");
  }
});

test("a graphql block without a connector is refused at save time, with a connector it is accepted", () => {
  const graphqlStep = {
    id: "teams",
    kind: "request",
    method: "POST",
    graphql: { query: "query { teams(first:50) { nodes { id } } }" },
  };
  const connectorless = validateWorkflowDef(
    define([{ ...graphqlStep, url: "${connector.linear.base_url}" }]),
  );
  expect(connectorless.ok).toBe(false);
  expect(connectorless.errors).toEqual([
    {
      path: "steps.teams.connector_id",
      message:
        "a graphql block needs connector_id — a GraphQL endpoint is addressed as a connector; without one the step would send an empty, unauthenticated HTTP request. Set connector_id to a graphql connector (or the recipe placeholder bound via required_connectors) and drop url.",
    },
  ]);
  expect(validateWorkflowDef(define([{ ...graphqlStep, connector_id: connector }])).errors).toEqual(
    [],
  );
});
