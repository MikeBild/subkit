import { expect, test } from "bun:test";
import {
  AuthorityExecutionShapeSchema,
  authorityExecutionShape,
} from "../authority-execution-shape.ts";
import { WorkflowDefSchema } from "../types.ts";

test("review uses runtime retry defaults and honors zero and explicit retries", () => {
  const definition = WorkflowDefSchema.parse({
    name: "Review",
    steps: [
      { id: "default", kind: "request", method: "GET", url: "https://example.test" },
      { id: "once", kind: "request", method: "POST", url: "https://example.test", max_retries: 0 },
      { id: "six", kind: "request", method: "POST", url: "https://example.test", max_retries: 5 },
    ],
  });
  const result = authorityExecutionShape(definition, [
    { step_id: "default", driver: "http", target: null },
    { step_id: "once", driver: "graphql", target: null },
    { step_id: "six", driver: "mcp", target: null },
  ]);
  expect(result.requests).toMatchObject([
    { step_id: "default", retry_policy_max_attempts: 5 },
    { step_id: "once", retry_policy_max_attempts: 1 },
    { step_id: "six", retry_policy_max_attempts: 6 },
  ]);
  expect(AuthorityExecutionShapeSchema.parse(result)).toEqual(result);
  expect(result.run_limit_is_request_limit).toBe(false);
});

test("review identifies nested loops and inline iteration without executing selectors", () => {
  const definition = WorkflowDefSchema.parse({
    name: "Loops",
    steps: [
      { id: "outer", kind: "loop", over: "input.items", body: ["inner"] },
      { id: "inner", kind: "loop", over: "input.other", body: ["send"] },
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: "https://example.test",
        for_each: "throw new Error('must not execute')",
      },
    ],
  });
  const result = authorityExecutionShape(definition, [
    { step_id: "send", driver: "http", target: null },
  ]);
  expect(result.iterations).toEqual([
    { step_id: "outer", kind: "loop", body_step_ids: ["inner"] },
    { step_id: "inner", kind: "loop", body_step_ids: ["send"] },
    { step_id: "send", kind: "for_each", body_step_ids: ["send"] },
  ]);
  expect(JSON.stringify(result)).not.toContain("must not execute");
});

test("review does not invent a retry policy for an unresolved or different driver", () => {
  const definition = WorkflowDefSchema.parse({
    name: "Unknown",
    steps: [{ id: "request", kind: "request", method: "GET", url: "https://example.test" }],
  });
  for (const bindings of [[], [{ step_id: "request", driver: "s3" as const, target: null }]]) {
    expect(
      authorityExecutionShape(definition, bindings).requests[0]?.retry_policy_max_attempts,
    ).toBeNull();
  }
});

test("review names each request's method and its target without query values", () => {
  const definition = WorkflowDefSchema.parse({
    name: "Targets",
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: "https://api.example.test/v1/orders?api_key=secret",
      },
      { id: "item", kind: "request", method: "GET", url: "https://api.example.test/v1/items" },
      { id: "tool", kind: "request", method: "GET", url: "https://mcp.example.test/mcp" },
      { id: "local", kind: "request", method: "GET", url: "https://example.test" },
    ],
  });
  const result = authorityExecutionShape(definition, [
    {
      step_id: "send",
      driver: "http",
      target: "https://user:pass@api.example.test/v1/orders?api_key=secret#frag",
    },
    { step_id: "item", driver: "http", target: "https://api.example.test/v1/items/{id}" },
    { step_id: "tool", driver: "mcp", target: "https://mcp.example.test/mcp#create_issue" },
    { step_id: "local", driver: "http", target: null },
  ]);
  expect(result.requests.map((request) => request.target)).toEqual([
    { method: "POST", url: "https://api.example.test/v1/orders" },
    { method: "GET", url: "https://api.example.test/v1/items/{id}" },
    { method: "MCP", url: "https://mcp.example.test/mcp" },
    { method: "GET", url: null },
  ]);
  expect(JSON.stringify(result.requests.map((request) => request.target))).not.toContain("secret");
  expect(AuthorityExecutionShapeSchema.parse(result)).toEqual(result);
});
