import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  compileWorkflowEffectManifest,
  type ResolvedEffectBinding,
} from "../core/effect-manifest.ts";
import { mcpBoundary, mcpBoundaryTarget, mcpToolDescriptorPin } from "../mcp-boundary.ts";
import {
  type ConnectorQuery,
  connectorQueryOf,
  requestBoundary,
  requestBoundaryTarget,
} from "../request-boundary.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";
const BASE = "https://example.test/api";

function fixture(request: Record<string, unknown>, own?: ConnectorQuery) {
  const definition = WorkflowDefSchema.parse(
    JSON.parse(
      JSON.stringify({
        name: "Bound request",
        steps: [{ id: "call", kind: "request", connector_id: connector, ...request }],
      }),
    ),
  );
  const step = definition.steps[0];
  if (step?.kind !== "request") throw new Error("missing request step");
  const boundary = requestBoundary(step, BASE, own);
  if (!boundary) throw new Error("boundary did not compile");
  const binding: ResolvedEffectBinding = {
    tenant_id: tenant,
    step_id: "call",
    connector_id: connector,
    driver: "http",
    environment: "dev",
    request_digest: workflowJsonDigest(step),
    target: requestBoundaryTarget(boundary),
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    boundary,
  };
  return {
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev" as const,
    execution_options_digest: "c".repeat(64),
    definition,
    bindings: [binding],
  };
}

const READ = {
  method: "GET",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  path: "/sites/${input.site}/stats",
  query: { tz: "UTC" },
  boundary: {
    variables: { "input.site": { enum: ["blog"] } },
    max_body_bytes: 0,
    max_calls: 1,
  },
};

function own(fixed: Record<string, unknown>, credential: string[]): ConnectorQuery {
  const query = connectorQueryOf(fixed, credential);
  if (!query) throw new Error("connector query fixture did not resolve");
  return query;
}

const OWN = own({ format: "json" }, ["api_key"]);

test("a boundary carrying the connector's own query keys is an approvable effect", () => {
  const compiled = compileWorkflowEffectManifest(fixture(READ, OWN));
  expect(compiled.manifest.issues).toEqual([]);
  expect(compiled.eligible_for_repeated_runs).toBe(true);
  expect(compiled.manifest.effects[0]?.boundary?.connector_query).toEqual(OWN);
  expect(compiled.manifest.effects[0]?.effect).toBe("read");
});

test("the manifest digest follows the connector's own query keys", () => {
  const digest = (own?: ConnectorQuery) => compileWorkflowEffectManifest(fixture(READ, own)).digest;
  const reviewed = digest(OWN);
  expect(digest(OWN)).toBe(reviewed);
  expect(digest()).not.toBe(reviewed);
  expect(digest(own({ format: "xml" }, ["api_key"]))).not.toBe(reviewed);
  expect(digest(own({ format: "json" }, ["key"]))).not.toBe(reviewed);
});

test("a binding whose connector keys the step could not have compiled with is a mismatch", () => {
  const input = fixture(READ, OWN);
  const binding = input.bindings[0];
  if (!binding?.boundary) throw new Error("missing boundary");
  binding.boundary = {
    ...binding.boundary,
    connector_query: { fixed: { tz: "UTC" }, credential: [] },
  };
  expect(() => compileWorkflowEffectManifest(input)).toThrow();
  const widened = fixture(READ, OWN);
  const widenedBinding = widened.bindings[0];
  if (!widenedBinding?.boundary) throw new Error("missing boundary");
  widenedBinding.boundary = {
    ...widenedBinding.boundary,
    query: { fixed: { tz: "UTC", debug: "1" }, variable: [] },
  };
  const compiled = compileWorkflowEffectManifest(widened);
  expect(compiled.manifest.issues).toContainEqual({ step_id: "call", code: "binding_mismatch" });
  expect(compiled.eligible_for_repeated_runs).toBe(false);
});

const BODY_PAGED = (max_pages: number | undefined = 4, extra: Record<string, unknown> = {}) => ({
  method: "POST",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  path: "/sites/${input.site}/search",
  body: { filter: "open" },
  pagination: {
    strategy: "cursor",
    cursor_request_param: "cursor",
    cursor_response_path: "$.next",
    max_pages,
    parameter_location: "body",
  },
  boundary: {
    variables: { "input.site": { enum: ["blog"] } },
    max_body_bytes: 200,
    max_calls: 1,
  },
  ...extra,
});

test("a step that pages through the body is an approvable effect with its page ceiling", () => {
  const compiled = compileWorkflowEffectManifest(fixture(BODY_PAGED()));
  expect(compiled.manifest.issues).toEqual([]);
  expect(compiled.eligible_for_repeated_runs).toBe(true);
  expect(compiled.manifest.effects[0]?.boundary?.pagination).toEqual({
    params: ["cursor"],
    max_requests: 4,
    location: "body",
  });
});

test("the manifest digest follows the body paging ceiling", () => {
  expect(compileWorkflowEffectManifest(fixture(BODY_PAGED(5))).digest).not.toBe(
    compileWorkflowEffectManifest(fixture(BODY_PAGED(4))).digest,
  );
});

test("a paging binding the step no longer compiles to is a mismatch and a dynamic request", () => {
  const input = fixture(BODY_PAGED());
  const binding = input.bindings[0];
  if (!binding?.boundary?.pagination) throw new Error("missing paging boundary");
  binding.boundary = {
    ...binding.boundary,
    pagination: { ...binding.boundary.pagination, max_requests: 400 },
  };
  const compiled = compileWorkflowEffectManifest(input);
  expect(compiled.manifest.issues).toEqual([
    { step_id: "call", code: "binding_mismatch" },
    { step_id: "call", code: "dynamic_request" },
  ]);
  expect(compiled.eligible_for_repeated_runs).toBe(false);
});

const SERVER = "https://mcp.example.test/mcp";
const PIN = mcpToolDescriptorPin({
  name: "search",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
});

function toolFixture(boundary: Record<string, unknown> | null, bind = true) {
  const definition = WorkflowDefSchema.parse(
    JSON.parse(
      JSON.stringify({
        name: "Bound tool call",
        steps: [
          {
            id: "call",
            kind: "request",
            connector_id: connector,
            max_retries: 0,
            mcp: {
              operation: "call_tool",
              tool: "search",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
              arguments: { q: "${input.q}" },
              ...(boundary
                ? {
                    boundary: {
                      variables: { "input.q": { enum: ["alpha"] } },
                      max_calls: 2,
                      descriptor: {
                        input_schema_digest: PIN.input_schema_digest,
                        annotations: PIN.annotations,
                      },
                      ...boundary,
                    },
                  }
                : {}),
            },
          },
        ],
      }),
    ),
  );
  const step = definition.steps[0];
  if (step?.kind !== "request") throw new Error("missing request step");
  const compiled = bind ? mcpBoundary(step, SERVER) : null;
  const binding: ResolvedEffectBinding = {
    tenant_id: tenant,
    step_id: "call",
    connector_id: connector,
    driver: "mcp",
    environment: "dev",
    request_digest: workflowJsonDigest(step),
    target: compiled ? mcpBoundaryTarget(compiled) : null,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    ...(compiled ? { mcp: compiled } : {}),
  };
  return {
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev" as const,
    execution_options_digest: "c".repeat(64),
    definition,
    bindings: [binding],
  };
}

test("a bounded tool call carries the effect a person stated", () => {
  const read = compileWorkflowEffectManifest(toolFixture({ effect: "read" }));
  expect(read.manifest.issues).toEqual([]);
  expect(read.eligible_for_repeated_runs).toBe(true);
  expect(read.manifest.effects[0]).toMatchObject({
    effect: "read",
    operation: "tools/call:search",
    target: "https://mcp.example.test/mcp#search",
    mcp: { tool: "search", effect: "read", max_calls: 2, descriptor: PIN },
  });
  const write = compileWorkflowEffectManifest(toolFixture({ effect: "write" }));
  expect(write.manifest.issues).toEqual([]);
  expect(write.manifest.effects[0]?.effect).toBe("write");
});

test("a tool call whose effect nobody stated is approved as a write, never as a read", () => {
  const unstated = compileWorkflowEffectManifest(toolFixture({}));
  expect(unstated.manifest.issues).toEqual([]);
  expect(unstated.manifest.effects[0]?.effect).toBe("write");
});

test("a tool call without a compiled boundary keeps an unknown effect and stays unapproved", () => {
  for (const input of [toolFixture(null), toolFixture({ effect: "read" }, false)]) {
    const compiled = compileWorkflowEffectManifest(input);
    expect(compiled.manifest.effects[0]?.effect).toBe("unknown");
    expect(compiled.manifest.issues).toEqual([
      { step_id: "call", code: "dynamic_request" },
      { step_id: "call", code: "unknown_effect" },
    ]);
    expect(compiled.eligible_for_repeated_runs).toBe(false);
  }
});

test("the manifest digest follows the tool boundary and the pinned tool", () => {
  const reviewed = compileWorkflowEffectManifest(toolFixture({ effect: "read" })).digest;
  expect(compileWorkflowEffectManifest(toolFixture({ effect: "read" })).digest).toBe(reviewed);
  for (const changed of [
    { effect: "write" },
    { effect: "read", max_calls: 3 },
    { effect: "read", variables: { "input.q": { enum: ["alpha", "beta"] } } },
    {
      effect: "read",
      descriptor: { input_schema_digest: "f".repeat(64), annotations: PIN.annotations },
    },
    { effect: "read", descriptor: { input_schema_digest: PIN.input_schema_digest } },
  ])
    expect(compileWorkflowEffectManifest(toolFixture(changed)).digest).not.toBe(reviewed);
});

test("a tool binding the step does not compile to is a mismatch with an unknown effect", () => {
  const input = toolFixture({ effect: "read" });
  const binding = input.bindings[0];
  if (!binding?.mcp) throw new Error("missing tool boundary");
  binding.mcp = { ...binding.mcp, max_calls: 500 };
  const widened = compileWorkflowEffectManifest(input);
  expect(widened.manifest.effects[0]?.effect).toBe("unknown");
  expect(widened.manifest.issues).toEqual([
    { step_id: "call", code: "binding_mismatch" },
    { step_id: "call", code: "dynamic_request" },
    { step_id: "call", code: "unknown_effect" },
  ]);
  const moved = toolFixture({ effect: "read" });
  const movedBinding = moved.bindings[0];
  if (!movedBinding) throw new Error("missing binding");
  movedBinding.target = "https://elsewhere.example.test/mcp#search";
  const compiled = compileWorkflowEffectManifest(moved);
  expect(compiled.manifest.issues).toContainEqual({ step_id: "call", code: "binding_mismatch" });
  expect(compiled.eligible_for_repeated_runs).toBe(false);
});

test("a tool boundary on a binding of another driver is a mismatch", () => {
  const input = toolFixture({ effect: "read" });
  const binding = input.bindings[0];
  if (!binding) throw new Error("missing binding");
  binding.driver = "http";
  const compiled = compileWorkflowEffectManifest(input);
  expect(compiled.manifest.issues).toEqual([
    { step_id: "call", code: "binding_mismatch" },
    { step_id: "call", code: "binding_mismatch" },
    { step_id: "call", code: "dynamic_request" },
  ]);
  expect(compiled.eligible_for_repeated_runs).toBe(false);
});
