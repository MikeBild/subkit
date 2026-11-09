import { describe, expect, test } from "bun:test";
import { projectWorkflowDraft } from "./draft-projection.ts";

describe("projectWorkflowDraft", () => {
  test("uses catalog-owned description while preserving the stored draft definition", () => {
    const draft = projectWorkflowDraft(
      { id: "wf-1", current_version_id: "v-current", description: "Catalog description" },
      {
        id: "v-draft",
        version: 4,
        dag: {
          name: "Nightly digest",
          steps: [{ id: "result", kind: "transform", expression: "return {};" }],
        },
        spec: null,
      },
    );
    expect(draft).toMatchObject({
      workflow_id: "wf-1",
      version_id: "v-draft",
      version: 4,
      current_version_id: "v-current",
      definition: {
        name: "Nightly digest",
        description: "Catalog description",
        steps: [{ id: "result", kind: "transform", expression: "return {};" }],
      },
      spec: null,
    });
    expect(draft.digest).toHaveLength(64);
  });

  test("does not replace an explicit draft description", () => {
    const draft = projectWorkflowDraft(
      { id: "wf-1", current_version_id: null, description: "Catalog description" },
      {
        id: "v-draft",
        version: 1,
        dag: {
          name: "Nightly digest",
          description: "Draft description",
          steps: [{ id: "result", kind: "transform", expression: "return {};" }],
        },
        spec: null,
      },
    );
    expect(draft.definition.description).toBe("Draft description");
  });
});
