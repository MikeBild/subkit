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
    expect(out!).toContain("$scope.fetch_projects.data");
    expect(out!).toContain("$scope.extract_projects.data");
    expect(out!).toContain("$scope.fetch_resources.data");
    expect(out!).toContain("$item");
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

  it("surfaces $item.<field> keys from latest_preview.step_traces", () => {
    const out = renderAuthoringContextBlock({
      draft: {
        mode: "workflow_authoring",
        workflow: {
          name: "list-projects-resources",
          slug: "list-projects-resources",
          steps: [
            {
              id: "list_projects",
              kind: "request",
              method: "GET",
              url: "/v2/projects",
            },
            {
              id: "fetch_resources",
              kind: "loop",
              over: "$scope.list_projects.data.projects",
              body: ["get_project_resources"],
            },
            {
              id: "get_project_resources",
              kind: "request",
              method: "GET",
              url: "/v2/projects/{project_id}/resources",
            },
          ],
        },
        latest_preview: {
          ok: true,
          summary: "ok",
          step_traces: [
            {
              step_id: "list_projects",
              kind: "request",
              status: "succeeded",
              output_preview: {
                projects: [
                  {
                    id: "d6742174",
                    name: "Acme",
                    owner_uuid: "0e489f44",
                    purpose: "Service or API",
                  },
                ],
              },
            },
          ],
        },
      } as unknown as Parameters<typeof renderAuthoringContextBlock>[0]["draft"],
      user_message: "hi",
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("$item.{ id, name, owner_uuid, purpose }");
    expect(out!).toContain("sampled from preview of `list_projects`");
  });

  it("surfaces real $scope.<step>.data.<path> candidates from a non-loop step's scope_at_step", () => {
    const out = renderAuthoringContextBlock({
      draft: {
        mode: "workflow_authoring",
        workflow: {
          name: "online-chargers",
          slug: "online-chargers",
          steps: [
            { id: "fetch_chargers", kind: "request", method: "POST", url: "/graphql" },
            { id: "filter_connected", kind: "transform", expression: "{ ... }" },
          ],
        },
        latest_preview: {
          ok: true,
          summary: "ok",
          step_traces: [
            {
              step_id: "fetch_chargers",
              kind: "request",
              status: "succeeded",
              output_preview: { chargers: { edges: [{ node: { id: "c1" } }] } },
              scope_at_step: {
                available_paths: [
                  "chargers",
                  "chargers.edges",
                  "chargers.edges[0]",
                  "chargers.edges[0].node",
                  "chargers.edges[0].node.id",
                ],
                shape_summary: "object",
                primary_data_path: "chargers.edges",
              },
            },
          ],
        },
      } as unknown as Parameters<typeof renderAuthoringContextBlock>[0]["draft"],
      user_message: "hi",
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("$scope.fetch_chargers.data.chargers.edges");
    expect(out!).toContain("real paths from last preview");
    expect(out!).not.toContain("chargers.edges[0]");
  });

  it("hints to run dry_run_workflow when the loop source has no recorded preview", () => {
    const out = renderAuthoringContextBlock({
      draft: {
        mode: "workflow_authoring",
        workflow: {
          name: "list-projects-resources",
          slug: "list-projects-resources",
          steps: [
            { id: "list_projects", kind: "request", method: "GET", url: "/v2/projects" },
            {
              id: "fetch_resources",
              kind: "loop",
              over: "$scope.list_projects.data.projects",
              body: ["get_project_resources"],
            },
            {
              id: "get_project_resources",
              kind: "request",
              method: "GET",
              url: "/v2/projects/{project_id}/resources",
            },
          ],
        },
      } as unknown as Parameters<typeof renderAuthoringContextBlock>[0]["draft"],
      user_message: "hi",
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("$item shape unknown");
    expect(out!).toContain("run `dry_run_workflow`");
  });

  it("handles data_selector form (sourceData.<step>.…)", () => {
    const out = renderAuthoringContextBlock({
      draft: {
        mode: "workflow_authoring",
        workflow: {
          name: "list-msgs",
          slug: "list-msgs",
          steps: [
            { id: "list_messages", kind: "request", method: "GET", url: "/messages" },
            {
              id: "fetch_each",
              kind: "loop",
              data_selector: "(sourceData) => sourceData.list_messages.data.messages",
              body: ["get_message"],
            },
            {
              id: "get_message",
              kind: "request",
              method: "GET",
              url: "/messages/{id}",
            },
          ],
        },
        latest_preview: {
          ok: true,
          summary: "ok",
          step_traces: [
            {
              step_id: "list_messages",
              kind: "request",
              status: "succeeded",
              output_preview: {
                messages: [
                  { id: "19e1b6", threadId: "19e1b6" },
                  { id: "19e1ae", threadId: "19e1ae" },
                ],
              },
            },
          ],
        },
      } as unknown as Parameters<typeof renderAuthoringContextBlock>[0]["draft"],
      user_message: "hi",
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("$item.{ id, threadId }");
    expect(out!).toContain("sampled from preview of `list_messages`");
  });
});
