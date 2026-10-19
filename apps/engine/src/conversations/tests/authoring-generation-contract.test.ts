import { expect, test } from "bun:test";
import { buildGenerationPrompt } from "../authoring-pipeline.ts";

test("nested generation keeps the user's goal while separating outer interactive procedures", () => {
  const goal =
    "Load the skill, discover schemas, then call author_workflow to create a workflow that returns its input.";
  const prompt = buildGenerationPrompt({
    goal,
    connectors: [],
    docsByConnector: new Map(),
    samplesSection: null,
    input_example: { message: "example" },
  });
  expect(prompt).toContain(goal);
  expect(prompt).toContain("nested schema-generation stage");
  expect(prompt).toContain(
    "You cannot invoke load_skill, schema-discovery tools or author_workflow here",
  );
  expect(prompt).toContain("not actions for this nested generation stage");
  expect(prompt).toContain("If a required fact is absent, use abort");
  expect(prompt).toContain(
    "never invent endpoints, credentials, caller identities or approval evidence",
  );
  expect(prompt).toContain('"message": "example"');
  expect(prompt).toContain("FUNCTION BODY");
});
