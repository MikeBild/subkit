import { describe, expect, test } from "bun:test";
import { lossyGraphqlConversions } from "../graphql-conversion.ts";
import {
  convertedProjectItemsStep,
  graphqlProjectItemsStep,
  RADAR_SEARCH_STEP,
  REST_ITEMS_STEP,
} from "./fixtures/graphql-over-http.ts";

const workflow = (...steps: Record<string, unknown>[]) => ({ name: "briefing", steps });

describe("lossyGraphqlConversions", () => {
  test("names a graphql step that became a POST to a GraphQL endpoint", () => {
    expect(
      lossyGraphqlConversions(
        workflow(graphqlProjectItemsStep()),
        workflow(convertedProjectItemsStep()),
      ),
    ).toEqual(["project_items"]);
  });

  test("ignores an edit inside the graphql block, a REST rewrite and untouched POST steps", () => {
    const edited = graphqlProjectItemsStep();
    edited.graphql.variables.number = 4;
    expect(lossyGraphqlConversions(workflow(graphqlProjectItemsStep()), workflow(edited))).toEqual(
      [],
    );
    expect(
      lossyGraphqlConversions(workflow(graphqlProjectItemsStep()), workflow(REST_ITEMS_STEP)),
    ).toEqual([]);
    expect(
      lossyGraphqlConversions(workflow(RADAR_SEARCH_STEP), workflow(RADAR_SEARCH_STEP)),
    ).toEqual([]);
  });
});
