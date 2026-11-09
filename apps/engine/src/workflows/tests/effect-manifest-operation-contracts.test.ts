import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  compileWorkflowEffectManifest,
  type ResolvedEffectBinding,
} from "../core/effect-manifest.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";

function compiled(request: Record<string, unknown>, driver: ResolvedEffectBinding["driver"]) {
  const definition = WorkflowDefSchema.parse({
    name: "Operation dispatch",
    steps: [{ id: "effect", kind: "request", connector_id: connector, ...request }],
  });
  const step = definition.steps[0]!;
  const binding: ResolvedEffectBinding = {
    tenant_id: tenant,
    step_id: "effect",
    connector_id: connector,
    driver,
    environment: "dev",
    request_digest: workflowJsonDigest(step),
    target: "https://reviewed.example.test/target",
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
  };
  return compileWorkflowEffectManifest({
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev",
    execution_options_digest: "c".repeat(64),
    definition,
    bindings: [binding],
  });
}

test("operation and effect dispatch preserve each reviewed protocol's semantics", () => {
  const cases = [
    ["HTTP write override", { method: "GET", side_effects: "write" }, "http", "GET", "write"],
    [
      "native GraphQL query",
      { method: "POST", graphql: { query: "query Viewer { viewer { login } }" } },
      "graphql",
      "query",
      "read",
    ],
    [
      "native GraphQL mutation",
      { method: "POST", graphql: { query: "mutation Close { closeIssue { id } }" } },
      "graphql",
      "mutation",
      "write",
    ],
    [
      "MCP tool",
      { method: "POST", mcp: { operation: "call_tool", tool: "lookup", arguments: {} } },
      "mcp",
      "tools/call:lookup",
      "unknown",
    ],
    [
      "MCP resource",
      { method: "GET", mcp: { operation: "read_resource", uri: "resource://reviewed" } },
      "mcp",
      "read_resource",
      "read",
    ],
    [
      "MCP prompt",
      { method: "GET", mcp: { operation: "get_prompt", prompt: "reviewed" } },
      "mcp",
      "get_prompt",
      "read",
    ],
    [
      "SQL",
      { method: "SELECT", sql: { query: "SELECT id FROM reviewed" } },
      "postgres",
      "sql",
      "unknown",
    ],
    [
      "S3 deletion",
      { method: "DELETE", s3: { key: "reviewed/object.json" } },
      "s3",
      "DELETE",
      "destructive",
    ],
  ] as const;
  for (const [_name, request, driver, operation, effect] of cases) {
    const result = compiled(request, driver);
    expect(result.manifest.effects[0]).toMatchObject({ driver, operation, effect });
  }
});

test("rejected driver bindings do not change the effect classification they expose", () => {
  const mcpOnHttp = compiled({ method: "POST", path: "/reviewed" }, "mcp");
  expect(mcpOnHttp.manifest.issues).toEqual([{ step_id: "effect", code: "binding_mismatch" }]);
  expect(mcpOnHttp.manifest.effects[0]).toMatchObject({
    driver: "mcp",
    operation: "unknown",
    effect: "write",
  });

  const graphqlOnHttp = compiled({ method: "POST", path: "/reviewed" }, "graphql");
  expect(graphqlOnHttp.manifest.issues).toEqual([
    { step_id: "effect", code: "binding_mismatch" },
    { step_id: "effect", code: "unknown_effect" },
  ]);
  expect(graphqlOnHttp.manifest.effects[0]).toMatchObject({
    driver: "graphql",
    operation: "unknown",
    effect: "unknown",
  });
});

test("MCP and S3 classification cannot fall back to the HTTP method", () => {
  const mcp = compiled(
    { method: "POST", mcp: { operation: "get_prompt", prompt: "reviewed" } },
    "mcp",
  );
  expect(mcp.manifest.issues).toEqual([]);
  expect(mcp.manifest.effects[0]).toMatchObject({ operation: "get_prompt", effect: "read" });

  const s3 = compiled({ method: "LIST", s3: { prefix: "reviewed/" } }, "s3");
  expect(s3.manifest.issues).toEqual([]);
  expect(s3.manifest.effects[0]).toMatchObject({ operation: "LIST", effect: "read" });
});

test("GraphQL classification precedes DELETE handling and honors an explicit operation", () => {
  const queryOverDelete = compiled(
    {
      method: "DELETE",
      path: "/graphql",
      graphql: { query: "query Viewer { viewer { login } }" },
    },
    "http",
  );
  expect(queryOverDelete.manifest.issues).toEqual([]);
  expect(queryOverDelete.manifest.effects[0]).toMatchObject({ operation: "query", effect: "read" });

  for (const driver of ["http", "graphql"] as const) {
    const mutationOverride = compiled(
      {
        method: "POST",
        ...(driver === "http" ? { path: "/graphql" } : {}),
        graphql: {
          operation: "mutation",
          query: "query Viewer { viewer { login } }",
        },
      },
      driver,
    );
    expect(mutationOverride.manifest.issues).toEqual([]);
    expect(mutationOverride.manifest.effects[0]).toMatchObject({
      operation: "query",
      effect: "write",
    });
  }
});

test("inconsistent bindings cannot promote MCP tools or valid GraphQL documents to unknown", () => {
  const mcpWithHttpBinding = compiled(
    { method: "POST", mcp: { operation: "call_tool", tool: "reviewed", arguments: {} } },
    "http",
  );
  expect(mcpWithHttpBinding.manifest.issues).toEqual([
    { step_id: "effect", code: "binding_mismatch" },
  ]);
  expect(mcpWithHttpBinding.manifest.effects[0]).toMatchObject({
    operation: "POST",
    effect: "write",
  });

  const graphql = compiled(
    { method: "POST", graphql: { query: "query Viewer { viewer { login } }" } },
    "graphql",
  );
  expect(graphql.manifest.issues).toEqual([]);
  expect(graphql.manifest.effects[0]).toMatchObject({ operation: "query", effect: "read" });
});

test("driver-specific GraphQL and DELETE guards do not leak across inconsistent bindings", () => {
  const s3Graphql = compiled(
    {
      method: "POST",
      graphql: { query: "query Viewer { viewer { login } }" },
    },
    "s3",
  );
  expect(s3Graphql.manifest.issues).toEqual([{ step_id: "effect", code: "binding_mismatch" }]);
  expect(s3Graphql.manifest.effects[0]).toMatchObject({ operation: "POST", effect: "read" });

  const invalidS3Graphql = compiled(
    { method: "POST", graphql: { query: "query Broken { viewer {" } },
    "s3",
  );
  expect(invalidS3Graphql.manifest.issues).toEqual([
    { step_id: "effect", code: "binding_mismatch" },
  ]);
  expect(invalidS3Graphql.manifest.effects[0]).toMatchObject({
    operation: "POST",
    effect: "write",
  });

  const deleteS3Graphql = compiled(
    {
      method: "DELETE",
      graphql: { query: "query Viewer { viewer { login } }" },
    },
    "s3",
  );
  expect(deleteS3Graphql.manifest.issues).toEqual([
    { step_id: "effect", code: "binding_mismatch" },
    { step_id: "effect", code: "destructive_effect" },
  ]);
  expect(deleteS3Graphql.manifest.effects[0]).toMatchObject({
    operation: "DELETE",
    effect: "destructive",
  });

  const mcpDelete = compiled(
    { method: "DELETE", mcp: { operation: "read_resource", uri: "resource://reviewed" } },
    "mcp",
  );
  expect(mcpDelete.manifest.issues).toEqual([]);
  expect(mcpDelete.manifest.effects[0]).toMatchObject({
    operation: "read_resource",
    effect: "read",
  });

  const httpOptions = compiled({ method: "OPTIONS", path: "/reviewed" }, "http");
  expect(httpOptions.manifest.issues).toEqual([]);
  expect(httpOptions.manifest.effects[0]).toMatchObject({ operation: "OPTIONS", effect: "read" });
});
