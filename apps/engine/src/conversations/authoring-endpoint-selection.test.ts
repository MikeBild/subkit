import { describe, expect, test } from "bun:test";
import type { DiscoveredEndpoint } from "../connectors/discovery/types.ts";
import { selectDiscoveredEndpoints } from "./authoring-endpoint-selection.ts";

function endpoint(path: string, summary: string | null = null): DiscoveredEndpoint {
  return {
    method: "GET",
    path,
    summary,
    description: null,
    operation_id: null,
    scopes: [],
    params: [],
    request_body_schema: null,
    request_content_type: null,
    response_schemas: {},
    pagination_hint: null,
    deprecated: false,
  };
}

describe("authoring endpoint selection", () => {
  test("prioritizes relevant operations beyond the initial catalog window", () => {
    const endpoints = Array.from({ length: 50 }, (_, index) => endpoint(`/unrelated/${index}`));
    endpoints.push(endpoint("/repos/{owner}/{repo}/pulls", "List pull requests"));
    endpoints.push(endpoint("/repos/{owner}/{repo}/actions/runs", "List workflow runs"));

    const selected = selectDiscoveredEndpoints(
      endpoints,
      "Report pull requests and GitHub Actions runs",
      40,
    );

    expect(selected).toHaveLength(40);
    expect(selected.map((entry) => entry.path)).toContain("/repos/{owner}/{repo}/pulls");
    expect(selected.map((entry) => entry.path)).toContain("/repos/{owner}/{repo}/actions/runs");
    expect(endpoints[0]?.path).toBe("/unrelated/0");
  });

  test("preserves source order when the goal has no matching terms", () => {
    const endpoints = [endpoint("/first"), endpoint("/second"), endpoint("/third")];
    expect(
      selectDiscoveredEndpoints(endpoints, "unmatched request", 2).map((entry) => entry.path),
    ).toEqual(["/first", "/second"]);
  });
});
