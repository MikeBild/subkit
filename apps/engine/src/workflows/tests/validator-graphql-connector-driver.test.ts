import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../validator.ts";

const connectorId = "11d24801-726b-4733-8d29-72bd922f08b0";

const githubHttp = { driver: "http", base_url: "https://api.github.com", auth_type: "bearer" };
const graphqlConnector = { driver: "graphql", base_url: "https://api.github.com/graphql" };

const definition = (step: Record<string, unknown> = {}) => ({
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
      ...step,
    },
  ],
});

const stepErrors = (result: ReturnType<typeof validateWorkflowDef>) =>
  result.errors.filter((entry) => entry.path.startsWith("steps.project_items"));

describe("validateWorkflowDef · graphql block connector driver", () => {
  test("asks for path /graphql when a graphql block on an http connector has no path", () => {
    const result = validateWorkflowDef(definition(), {
      connectorGraphqlTargets: new Map([[connectorId, [githubHttp]]]),
    });
    expect(result.ok).toBe(false);
    const error = result.errors.find((entry) => entry.path === "steps.project_items.graphql");
    expect(error?.message).toContain('path "/graphql"');
    expect(error?.message).toContain("cursor_pagination");
    expect(error?.message).not.toContain("separate");
  });

  test("accepts a graphql block on an http connector with path /graphql", () => {
    const result = validateWorkflowDef(definition({ path: "/graphql" }), {
      connectorGraphqlTargets: new Map([[connectorId, [githubHttp]]]),
    });
    expect(stepErrors(result)).toEqual([]);
  });

  test.each([
    "graphql",
    "//evil.example/graphql",
    "/a/../graphql",
    "/graphql?x=1",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: refused placeholder shape
    "/${input.host}",
  ])("refuses the path %p at steps.<id>.path without echoing it", (path) => {
    const result = validateWorkflowDef(definition({ path }), {
      connectorGraphqlTargets: new Map([[connectorId, [githubHttp]]]),
    });
    const errors = stepErrors(result).filter((entry) => entry.path === "steps.project_items.path");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("fixed path on the connector host");
    expect(errors[0]?.message).not.toContain("evil");
  });

  test("refuses a step url next to the graphql block on an http connector", () => {
    const result = validateWorkflowDef(
      definition({ path: "/graphql", url: "https://api.github.com/graphql" }),
      { connectorGraphqlTargets: new Map([[connectorId, [githubHttp]]]) },
    );
    expect(stepErrors(result).some((entry) => entry.path === "steps.project_items.url")).toBe(true);
  });

  test("accepts a graphql block on a graphql connector", () => {
    const result = validateWorkflowDef(definition(), {
      connectorGraphqlTargets: new Map([[connectorId, [graphqlConnector]]]),
    });
    expect(stepErrors(result)).toEqual([]);
  });

  test("refuses another driver", () => {
    const result = validateWorkflowDef(definition({ path: "/graphql" }), {
      connectorGraphqlTargets: new Map([[connectorId, [{ driver: "postgres", base_url: null }]]]),
    });
    const error = result.errors.find((entry) => entry.path === "steps.project_items.graphql");
    expect(error?.message).toContain("driver 'postgres'");
  });

  test("validates every environment of the connector", () => {
    const result = validateWorkflowDef(definition(), {
      connectorGraphqlTargets: new Map([[connectorId, [graphqlConnector, githubHttp]]]),
    });
    expect(result.errors.some((entry) => entry.path === "steps.project_items.graphql")).toBe(true);
    const withPath = validateWorkflowDef(definition({ path: "/graphql" }), {
      connectorGraphqlTargets: new Map([[connectorId, [graphqlConnector, githubHttp]]]),
    });
    expect(stepErrors(withPath)).toEqual([]);
  });
});
