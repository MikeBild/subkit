import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../validator.ts";
import {
  convertedProjectItemsStep,
  NOTION_SEARCH_STEP,
  RADAR_SEARCH_STEP,
  REST_ITEMS_STEP,
} from "./fixtures/graphql-over-http.ts";

function errorsFor(step: Record<string, unknown>) {
  const result = validateWorkflowDef({ name: "briefing", steps: [step] });
  return result.errors.filter((entry) => entry.path.startsWith(`steps.${step.id}`));
}

describe("validateWorkflowDef · GraphQL over plain HTTP", () => {
  test("refuses the converted briefing step whose POSTed document does not parse", () => {
    const errors = errorsFor(convertedProjectItemsStep());
    const error = errors.find((entry) => entry.path === "steps.project_items.body.query");
    expect(error?.message).toContain("not a valid GraphQL document");
    expect(error?.message).toContain("https://api.github.com/graphql");
    expect(error?.message).toContain("cursor_pagination");
  });

  test("refuses a mutation declared as a read", () => {
    const errors = errorsFor({
      ...convertedProjectItemsStep(),
      side_effects: "read",
      body: { query: 'mutation { addStar(input: {starrableId: "1"}) { clientMutationId } }' },
    });
    const error = errors.find((entry) => entry.path === "steps.project_items.side_effects");
    expect(error?.message).toContain("mutation");
  });

  test("accepts a valid read-labelled query, a non-GraphQL POST search and a REST read", () => {
    expect(errorsFor(RADAR_SEARCH_STEP)).toEqual([]);
    expect(errorsFor(NOTION_SEARCH_STEP)).toEqual([]);
    expect(errorsFor(REST_ITEMS_STEP)).toEqual([]);
  });

  test("leaves a runtime-assembled document to run-time classification", () => {
    expect(
      errorsFor({
        ...convertedProjectItemsStep(),
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored workflow placeholder
        body: { query: "${input.document}" },
      }).filter((entry) => entry.path.endsWith("body.query")),
    ).toEqual([]);
  });
});
