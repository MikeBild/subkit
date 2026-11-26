import { expect, test } from "bun:test";
import { mcpBoundary } from "./mcp-boundary.ts";
import {
  compileRequestBoundary,
  describeRequestBoundaryViolation,
  RequestBoundarySchema,
  requestBoundaryViolation,
} from "./request-boundary.ts";
import { BASE, step } from "./request-boundary-fixtures.ts";
import { RequestStepSchema } from "./types.ts";

const owned = { "scope.make.data.id": { created_by_workflow: true as const } };
const removal = (extra: Record<string, unknown> = {}) =>
  step({
    method: "DELETE",
    path: "/jobs/${scope.make.data.id}",
    boundary: { variables: owned, max_body_bytes: 0, max_calls: 1, destructive: true },
    ...extra,
  });

test("a destructive DELETE may address an id this workflow created", () => {
  const { boundary, refusal } = compileRequestBoundary(removal(), BASE);
  expect(refusal).toBeUndefined();
  expect(boundary?.variables).toEqual(owned);
  expect(boundary?.segments).toEqual(["", "v2", "jobs", { var: "scope.make.data.id" }]);
  expect(
    requestBoundaryViolation(boundary!, {
      method: "DELETE",
      url: "https://api.example.test/v2/jobs/job-7",
      headers: {},
      body: null,
    }),
  ).toBeNull();
});

test("a value that cannot be a recorded id is outside the boundary and named", () => {
  const { boundary } = compileRequestBoundary(removal(), BASE);
  const violation = requestBoundaryViolation(boundary!, {
    method: "DELETE",
    url: "https://api.example.test/v2/jobs/..",
    headers: {},
    body: null,
  });
  expect(violation).toMatchObject({ kind: "target" });
  expect(
    describeRequestBoundaryViolation(
      requestBoundaryViolation(boundary!, {
        method: "DELETE",
        url: "https://api.example.test/v2/jobs/a%7Cb",
        headers: {},
        body: null,
      })!,
    ),
  ).toContain("outside its rule (an id this workflow created)");
});

test("the rule still needs destructive: true", () => {
  const step = removal({ boundary: { variables: owned, max_body_bytes: 0, max_calls: 1 } });
  expect(compileRequestBoundary(step, BASE).refusal).toBe("delete_requires_destructive");
});

test.each([
  [
    "another method",
    {
      method: "PATCH",
      boundary: { variables: owned, max_body_bytes: 100, max_calls: 1 },
    },
  ],
  [
    "a query value",
    {
      path: "/jobs",
      query: { id: "${scope.make.data.id}" },
    },
  ],
  ["a segment that is not the last", { path: "/jobs/${scope.make.data.id}/runs" }],
  [
    "a paged removal",
    {
      pagination: {
        strategy: "cursor",
        cursor_request_param: "start_cursor",
        cursor_response_path: "$.next_cursor",
        max_pages: 3,
      },
    },
  ],
  [
    "a collection that varies",
    {
      path: "/${input.team}/jobs/${scope.make.data.id}",
      boundary: {
        variables: { ...owned, "input.team": { enum: ["a"] } },
        max_body_bytes: 0,
        max_calls: 1,
        destructive: true,
      },
    },
  ],
])("the rule is refused on %s", (_name, extra) => {
  expect(compileRequestBoundary(removal(extra), BASE).refusal).toBe(
    "created_by_workflow_misplaced",
  );
});

test("the rule is refused without a connector", () => {
  const unbound = RequestStepSchema.parse({
    id: "drop",
    kind: "request",
    method: "DELETE",
    url: "https://api.example.test/v2/jobs/${scope.make.data.id}",
    boundary: { variables: owned, max_body_bytes: 0, max_calls: 1, destructive: true },
  });
  expect(compileRequestBoundary(unbound, null).refusal).toBe("created_by_workflow_misplaced");
});

test("the rule is refused for a runtime destination", () => {
  const fetch = RequestStepSchema.parse({
    id: "fetch",
    kind: "request",
    method: "POST",
    url: "${input.url}",
    idempotency_key: "${scope.make.data.id}",
    boundary: {
      variables: owned,
      max_body_bytes: 10,
      max_calls: 1,
      allowed_hosts: ["docs.example.com"],
    },
  });
  expect(compileRequestBoundary(fetch, null).refusal).toBe("created_by_workflow_misplaced");
});

test("a compiled DELETE boundary accepts the rule, a class stays refused", () => {
  const { boundary } = compileRequestBoundary(removal(), BASE);
  expect(RequestBoundarySchema.safeParse(boundary).success).toBe(true);
  expect(
    RequestBoundarySchema.safeParse({
      ...boundary,
      variables: { "scope.make.data.id": { class: "identifier" } },
    }).success,
  ).toBe(false);
});

test("an MCP tool call does not take the rule", () => {
  const call = RequestStepSchema.safeParse({
    id: "tool",
    kind: "request",
    protocol: "mcp",
    connector_id: "00000000-0000-4000-8000-000000000001",
    mcp: {
      operation: "call_tool",
      tool: "drop",
      arguments: { id: "${scope.make.data.id}" },
      boundary: { variables: owned, max_calls: 1 },
    },
  });
  expect(call.success ? mcpBoundary(call.data, "https://mcp.example.test") : null).toBeNull();
});
