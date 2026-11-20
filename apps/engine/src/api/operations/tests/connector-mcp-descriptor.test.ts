import { expect, test } from "bun:test";
import { compileMcpBoundary } from "../../../workflows/mcp-boundary.ts";
import { RequestStepSchema } from "../../../workflows/types.ts";
import { boundaryDescriptorOf } from "../connector-mcp.ts";

const TOOL = {
  name: "search",
  description: "search the index",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true, title: "Search" },
};

test("the listed descriptor is exactly what a step pins and what the server is compared with", () => {
  const descriptor = boundaryDescriptorOf(TOOL);
  expect(descriptor.annotations).toEqual({ readOnlyHint: true });
  expect(descriptor.input_schema_digest).toMatch(/^[a-f0-9]{64}$/);
  const step = RequestStepSchema.parse({
    id: "call",
    kind: "request",
    connector_id: "00000000-0000-4000-8000-000000000001",
    mcp: {
      operation: "call_tool",
      tool: "search",
      boundary: { effect: "read", variables: {}, max_calls: 1, descriptor },
    },
  });
  const { boundary } = compileMcpBoundary(step, "https://tools.example.test/mcp");
  expect(boundary?.descriptor.input_schema_digest).toBe(descriptor.input_schema_digest);
  expect(boundary?.descriptor.annotations).toEqual({ readOnlyHint: true });
});

test("a tool without annotations lists an empty set, never a missing one", () => {
  expect(boundaryDescriptorOf({ name: "plain", inputSchema: {} }).annotations).toEqual({});
});
