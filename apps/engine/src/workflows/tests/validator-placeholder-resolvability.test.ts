// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` tokens are the subject under test — they encode the placeholder grammar.
// Commit-time placeholder resolvability on request addressing surfaces
// (audit M4). The runtime fails a request step with
// `placeholder_unresolved` when path/url (or the graphql query/variables,
// or the s3 key/prefix) still carry tokens the resolver cannot substitute
// — production logged 67 runs of `unresolved placeholder(s) in path/url:
// ${item}` in 2 seconds. Every one of those defs was committable: the bare
// `${item}` (no field path) is a grammar error, but it slipped past the
// unsupported-placeholder linter (known kind) and the item-containment
// check (requires `item.` + field). validateWorkflowDef now parses the
// same grammar the resolver uses and rejects at commit.

import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../core/validator.ts";

function defWithSteps(steps: unknown[]): unknown {
  return { name: "resolvability probe", steps };
}

describe("validateWorkflowDef — addressing-surface placeholder resolvability", () => {
  test("bare `${item}` (no field path) in a url is rejected at commit", () => {
    const res = validateWorkflowDef(
      defWithSteps([
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/items/${item}",
        },
      ]),
    );
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.path === "steps.fetch.url");
    expect(err).toBeDefined();
    expect(err?.message).toContain("${item}");
    expect(err?.message).toContain("placeholder_unresolved");
  });

  test("a malformed `${input}` (no path) in s3.key is rejected", () => {
    const res = validateWorkflowDef(
      defWithSteps([
        {
          id: "put_report",
          kind: "request",
          method: "GET",
          connector_id: "5f6b2f64-9c1a-4b7e-8c4d-2c9d3e4f5a6b",
          s3: { key: "reports/${input}" },
        },
      ]),
    );
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.path === "steps.put_report.s3.key");
    expect(err).toBeDefined();
    expect(err?.message).toContain("${input}");
  });

  test("`${scope.<unknown step>}` in a path is rejected in strict mode, with a did-you-mean", () => {
    const res = validateWorkflowDef(
      defWithSteps([
        {
          id: "fetch_users",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/users",
        },
        {
          id: "fetch_details",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/details",
          path: "/v1/${scope.fetch_user.data.id}",
        },
      ]),
    );
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.path === "steps.fetch_details.path");
    expect(err).toBeDefined();
    expect(err?.message).toContain('unknown step "fetch_user"');
    expect(err?.message).toContain("fetch_users");
  });

  test("lenient authoring mode (allowForwardRefs) skips the unknown-scope check but still rejects grammar errors", () => {
    const forwardScope = validateWorkflowDef(
      defWithSteps([
        {
          id: "fetch_details",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/${scope.later_step.data.id}",
        },
      ]),
      { allowForwardRefs: true },
    );
    expect(forwardScope.ok).toBe(true);

    const malformed = validateWorkflowDef(
      defWithSteps([
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/items/${item}",
        },
      ]),
      { allowForwardRefs: true },
    );
    expect(malformed.ok).toBe(false);
  });

  test("well-formed placeholders on addressing surfaces still validate", () => {
    const res = validateWorkflowDef(
      defWithSteps([
        {
          id: "list_projects",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/projects",
        },
        {
          id: "fetch_project",
          kind: "request",
          method: "GET",
          url: "${connector.example.base_url}/projects/${item.id}?owner=${input.owner}&prev=${scope.list_projects.data.cursor}",
        },
        {
          id: "each_project",
          kind: "loop",
          over: "$scope.list_projects.data.projects",
          body: ["fetch_project"],
        },
      ]),
    );
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test("a malformed scope token inside graphql variables is rejected", () => {
    const res = validateWorkflowDef(
      defWithSteps([
        {
          id: "gql",
          kind: "request",
          method: "POST",
          connector_id: "7a1c3e5d-2b4f-4a6c-9d8e-1f2a3b4c5d6e",
          graphql: {
            query: "query ($id: ID!) { user(id: $id) { name } }",
            variables: { id: "${scope.whoami}" },
          },
        },
      ]),
    );
    expect(res.ok).toBe(false);
    const err = res.errors.find((e) => e.path.startsWith("steps.gql.graphql.variables"));
    expect(err).toBeDefined();
    expect(err?.message).toContain("${scope.whoami}");
  });

  test("a malformed GraphQL document is rejected before a workflow can be saved", () => {
    const res = validateWorkflowDef(
      defWithSteps([
        {
          id: "project_items",
          kind: "request",
          method: "GET",
          connector_id: "7a1c3e5d-2b4f-4a6c-9d8e-1f2a3b4c5d6e",
          graphql: {
            query: "query ProjectItems { viewer { repositories(first: 10) { nodes { name } }",
            cursor_pagination: {
              connection_path: "viewer.repositories",
              cursor_variable: "after",
              items_field: "nodes",
              max_pages: 10,
              max_items: 100,
            },
          },
        },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual({
      path: "steps.project_items.graphql.query",
      message: "graphql.query must be a valid GraphQL document containing an operation",
    });
  });

  test("an invalid request data selector is rejected before a workflow can be saved", () => {
    const res = validateWorkflowDef(
      defWithSteps([
        {
          id: "issues",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/issues",
          data_selector: "unknown",
        },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((error) => error.path === "steps.issues.data_selector")).toBe(true);
  });
});
