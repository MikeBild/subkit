// Pure-render tests for renderAuthoringContextBlock — no DB.

import { describe, expect, it } from "bun:test";
import { renderAuthoringContextBlock } from "../authoring-context-block.ts";

describe("renderAuthoringContextBlock — Document Analysis section", () => {
  it("emits the section when endpoint_count > 0", () => {
    const out = renderAuthoringContextBlock({
      draft: null,
      document_analysis: {
        source: "openapi",
        confidence: 92,
        endpoint_count: 6,
        sample_endpoints: [
          { method: "GET", path: "/v1/charges" },
          { method: "POST", path: "/v1/charges" },
        ],
      },
      user_message: "I uploaded a spec",
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("## Document Analysis");
    expect(out!).toContain("source=openapi");
    expect(out!).toContain("confidence=92%");
    expect(out!).toContain("endpoints=6");
    expect(out!).toContain("GET /v1/charges");
    expect(out!).toContain("POST /v1/charges");
  });

  it("omits the section when endpoint_count is 0", () => {
    const out = renderAuthoringContextBlock({
      draft: null,
      document_analysis: { source: "openapi", confidence: 0, endpoint_count: 0 },
      user_message: "anything",
    });
    expect(out ?? "").not.toContain("## Document Analysis");
  });

  it("omits the section when document_analysis is null", () => {
    const out = renderAuthoringContextBlock({
      draft: null,
      document_analysis: null,
      user_message: "anything",
    });
    expect(out ?? "").not.toContain("## Document Analysis");
  });

  it("renders no tone hint when expertise is omitted", () => {
    const out = renderAuthoringContextBlock({ draft: null, user_message: "hi" });
    expect(out ?? "").not.toContain("Tone hint");
  });

  it("renders the expertise tone hint when expertise is set", () => {
    const novice = renderAuthoringContextBlock({
      draft: null,
      user_message: "how do I start?",
      expertise: "novice",
    });
    expect(novice!).toContain("## Tone hint (novice)");
    expect(novice!).toContain("step-by-step");

    const expert = renderAuthoringContextBlock({
      draft: null,
      user_message: "diff only please",
      expertise: "expert",
    });
    expect(expert!).toContain("## Tone hint (expert)");
    expect(expert!).toContain("dense diffs");
  });

  it("renders only the first 6 endpoints with overflow note", () => {
    const sample = Array.from({ length: 10 }, (_, i) => ({
      method: "GET",
      path: `/v1/items/${i}`,
    }));
    const out = renderAuthoringContextBlock({
      draft: null,
      document_analysis: {
        source: "har",
        confidence: 98,
        endpoint_count: 10,
        sample_endpoints: sample,
      },
      user_message: "x",
    });
    expect(out!).toContain("/v1/items/0");
    expect(out!).toContain("/v1/items/5");
    expect(out!).not.toContain("/v1/items/6");
    expect(out!).toContain("…and 4 more");
  });
});

describe("renderAuthoringContextBlock — scope manifest (P4)", () => {
  it("emits a typed scope manifest for a workflow with a loop step", () => {
    const out = renderAuthoringContextBlock({
      draft: {
        mode: "workflow_authoring",
        workflow: {
          name: "list-projects-resources",
          slug: "list-projects-resources",
          steps: [
            { id: "fetch_projects", kind: "request", method: "GET", url: "/v2/projects" },
            {
              id: "extract_projects",
              kind: "transform",
              expression: "fetch_projects.data.projects",
            },
            {
              id: "fetch_resources",
              kind: "loop",
              over: "extract_projects.data",
              item_var: "project",
              body: ["get_project_resources"],
            },
            {
              id: "get_project_resources",
              kind: "request",
              method: "GET",
              url: "/v2/projects/{project_id}/resources",
            },
            { id: "format_output", kind: "transform", expression: "{ ... }" },
          ],
        },
      } as unknown as Parameters<typeof renderAuthoringContextBlock>[0]["draft"],
      user_message: "hi",
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("### Scope manifest");
    // Plain step paths
    expect(out!).toContain("$scope.fetch_projects.data");
    expect(out!).toContain("$scope.extract_projects.data");
    // Loop-specific shape with iteration variable + flat-access form
    expect(out!).toContain("$scope.fetch_resources.data");
    expect(out!).toContain("$project");
    expect(out!).toContain("flat access across all iterations");
    expect(out!).toContain("$scope.fetch_resources.data.get_project_resources.data");
    expect(out!).toContain("$scope.fetch_resources.data[0].get_project_resources.data");
  });

  it("omits the manifest section when the draft is empty", () => {
    const out = renderAuthoringContextBlock({
      draft: {
        mode: "workflow_authoring",
        workflow: { name: "(empty)", steps: [] },
      } as unknown as Parameters<typeof renderAuthoringContextBlock>[0]["draft"],
      user_message: "hi",
    });
    expect(out ?? "").not.toContain("### Scope manifest");
  });
});
