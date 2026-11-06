import { describe, expect, test } from "bun:test";
import { authoringCapabilitySignal } from "../authoring-capability.ts";
import { SkillCandidateFactsSchema } from "../types.ts";

const signal = authoringCapabilitySignal({
  workflow_id: "6f1c2e3a-0b4d-4c5e-8f60-718293a4b5c6",
  slug: "users-report",
  name: "Users report",
  def: {
    name: "Users report",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer" }, recipient: { type: "string" } },
      required: ["limit"],
    },
    output_schema: { type: "object", properties: { sent: { type: "boolean" } } },
    steps: [
      { id: "fetch", kind: "request", connector_id: "c-1" },
      { id: "shape", kind: "transform" },
      { id: "send", kind: "request", connector_id: "c-2" },
    ],
  },
  scope_index: {
    send: { available_paths: ["id", "threadId"], shape_summary: "object", primary_data_path: null },
  },
  draft_version_id: "v-2",
});

describe("a workflow capability note", () => {
  test("carries what it states as facts a person can read without the prose", () => {
    expect(SkillCandidateFactsSchema.parse(signal.facts)).toEqual({
      kind: "workflow_capability",
      inputs: [
        { name: "limit", type: "integer", required: true },
        { name: "recipient", type: "string", required: false },
      ],
      output_fields: ["sent"],
      key_paths: ["id", "threadId"],
      connector_ids: ["c-1", "c-2"],
      steps: [
        { id: "fetch", kind: "request" },
        { id: "shape", kind: "transform" },
        { id: "send", kind: "request" },
      ],
      draft_version_id: "v-2",
    });
  });

  test("its text for the drafting model is written from the same facts", () => {
    expect(signal.body).toContain("Inputs: limit: integer (required); recipient: string.");
    expect(signal.body).toContain("Output fields: sent.");
    expect(signal.body).toContain("Connectors: c-1, c-2.");
    expect(signal.body).toContain("Steps: request → transform → request.");
    expect(signal.body).not.toContain("Approving");
  });
});
