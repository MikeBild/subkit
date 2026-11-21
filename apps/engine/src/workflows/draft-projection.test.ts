import { describe, expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { projectWorkflowDraft } from "./draft-projection.ts";
import { WorkflowDraftSchema } from "./draft-schemas.ts";

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

  test("reads a draft that has no steps yet", () => {
    const draft = projectWorkflowDraft(
      { id: "wf-1", current_version_id: null, description: "Records returns" },
      { id: "v-draft", version: 1, dag: { name: "Returns intake", steps: [] }, spec: null },
    );
    expect(draft.definition).toEqual({
      name: "Returns intake",
      description: "Records returns",
      steps: [],
    });
    const uuid = createDeterministicUuidFactory(1);
    expect(
      WorkflowDraftSchema.parse({
        ...draft,
        workflow_id: uuid(),
        version_id: uuid(),
      }).definition.steps,
    ).toEqual([]);
  });
});
