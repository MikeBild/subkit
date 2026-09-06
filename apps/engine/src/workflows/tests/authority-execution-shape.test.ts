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
    { step_id: "default", driver: "http" },
    { step_id: "once", driver: "graphql" },
    { step_id: "six", driver: "mcp" },
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
  const result = authorityExecutionShape(definition, [{ step_id: "send", driver: "http" }]);
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
  for (const bindings of [[], [{ step_id: "request", driver: "s3" as const }]]) {
    expect(
      authorityExecutionShape(definition, bindings).requests[0]?.retry_policy_max_attempts,
    ).toBeNull();
  }
});
