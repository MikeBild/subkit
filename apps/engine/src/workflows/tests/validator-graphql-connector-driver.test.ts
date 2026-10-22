import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../validator.ts";

const connectorId = "11d24801-726b-4733-8d29-72bd922f08b0";

const definition = {
  name: "project-briefing",
  steps: [
    {
      id: "project_items",
      kind: "request",
      connector_id: connectorId,
      method: "GET",
      graphql: {
        operation: "query",
        query: "query Items($after: String) { viewer { login } }",
        variables: { after: null },
      },
    },
  ],
};

describe("validateWorkflowDef · graphql block connector driver", () => {
  test("refuses a graphql block on an http connector", () => {
    const result = validateWorkflowDef(definition, {
      connectorDrivers: new Map([[connectorId, ["http"]]]),
    });
    expect(result.ok).toBe(false);
    const error = result.errors.find((entry) => entry.path === "steps.project_items.graphql");
    expect(error?.message).toContain("driver 'http'");
    expect(error?.message).toContain("graphql connector");
    expect(error?.message).toContain("REST endpoint");
    expect(error?.message).toContain("Do not convert it to POST /graphql");
    expect(error?.message).toContain("cursor_pagination");
  });

  test("accepts a graphql block on a graphql connector", () => {
    const result = validateWorkflowDef(definition, {
      connectorDrivers: new Map([[connectorId, ["graphql"]]]),
    });
    expect(result.errors.filter((entry) => entry.path.startsWith("steps.project_items"))).toEqual(
      [],
    );
  });

  test("refuses when any environment of the connector is not graphql", () => {
    const result = validateWorkflowDef(definition, {
      connectorDrivers: new Map([[connectorId, ["graphql", "http"]]]),
    });
    expect(result.errors.some((entry) => entry.path === "steps.project_items.graphql")).toBe(true);
  });
});
