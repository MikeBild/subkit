import { expect, test } from "bun:test";
import { validateWorkflowDef } from "./validator.ts";

const connector = "00000000-0000-4000-8000-000000000001";
const request = { id: "fetch", kind: "request", method: "GET", url: "https://example.test" };
const define = (steps: unknown[]) => ({ name: "Boundary contracts", steps });

test("schema failures retain numeric paths and original messages, and a retired loop names its rewrite", () => {
  const result = validateWorkflowDef(
    define([
      { id: "each", kind: "loop", over: "fetch.data", body: ["fetch"] },
      request,
      { kind: "request" },
    ]),
  );
  expect(result.ok).toBe(false);
  expect(result.errors.find((error) => error.path === "steps.each")?.message).toBe(
    'The `loop` step kind is retired. Set `for_each: "(sourceData) => sourceData.fetch.data"` on step "fetch" and remove this step.',
  );
  expect(result.errors).toContainEqual({
    path: "steps.2.id",
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

test("known branch targets do not become forward references", () => {
  const known = validateWorkflowDef(
    define([
      { id: "choose", kind: "branch", when: "true", then_steps: [], else_steps: ["fetch"] },
      request,
    ]),
  );
  expect(known.errors).toEqual([]);
  expect(known).not.toHaveProperty("forward_refs");
});

test("S3 optional body and object-key boundaries distinguish read, put and delete", () => {
  for (const body of [undefined, null]) {
    const result = validateWorkflowDef(
      define([
        {
          protocol: "s3",
          ...request,
          method: "DELETE",
          connector_id: connector,
          s3: { key: "a" },
          body,
        },
      ]),
    );
    expect(result.errors).toEqual([]);
  }
  const put = validateWorkflowDef(
    define([
      {
        protocol: "s3",
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
        protocol: "s3",
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
  expect(result.errors[0]?.message).toContain("has no `for_each` declared");
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
