import { describe, expect, test } from "bun:test";
import {
  GRAPHQL_OVER_HTTP_REPAIR,
  GRAPHQL_OVER_HTTP_WARNING,
  lossyGraphqlConversions,
} from "../graphql-conversion.ts";
import {
  BRIEFING_CONNECTOR_ID,
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

  test("names a renamed POST /graphql step that replaces a removed graphql step", () => {
    expect(
      lossyGraphqlConversions(
        workflow(graphqlProjectItemsStep()),
        workflow({ ...convertedProjectItemsStep(), id: "project_items_http" }),
      ),
    ).toEqual(["project_items_http"]);
    expect(
      lossyGraphqlConversions(
        workflow(graphqlProjectItemsStep(), REST_ITEMS_STEP),
        workflow(
          { ...REST_ITEMS_STEP, id: "rest" },
          { ...convertedProjectItemsStep(), id: "added" },
        ),
      ),
    ).toEqual(["added"]);
  });

  test("resolves a converted step that posts to a GraphQL connector base_url", () => {
    const converted = { ...convertedProjectItemsStep(), path: "/" };
    const baseUrls = new Map([[BRIEFING_CONNECTOR_ID, ["https://api.github.com/graphql"]]]);
    expect(
      lossyGraphqlConversions(workflow(graphqlProjectItemsStep()), workflow(converted)),
    ).toEqual([]);
    expect(
      lossyGraphqlConversions(workflow(graphqlProjectItemsStep()), workflow(converted), baseUrls),
    ).toEqual(["project_items"]);
  });

  test("keeps a POST /graphql step that is added next to a kept graphql step", () => {
    expect(
      lossyGraphqlConversions(
        workflow(graphqlProjectItemsStep()),
        workflow(graphqlProjectItemsStep(), RADAR_SEARCH_STEP),
      ),
    ).toEqual([]);
  });

  test("the warning does not call a valid query a write", () => {
    expect(GRAPHQL_OVER_HTTP_WARNING).toContain("only the first page is read");
    expect(GRAPHQL_OVER_HTTP_WARNING).toContain(
      "a mutation or an unparseable or runtime-assembled document is reviewed as a write",
    );
    expect(GRAPHQL_OVER_HTTP_WARNING).not.toContain("the request is reviewed as a write");
    expect(GRAPHQL_OVER_HTTP_WARNING).toContain('set path "/graphql"');
  });

  test("the repair steers to path /graphql on the existing http connector first", () => {
    expect(GRAPHQL_OVER_HTTP_REPAIR).toMatch(/^The supported repair keeps the graphql block/);
    expect(GRAPHQL_OVER_HTTP_REPAIR).toContain('sets path "/graphql"');
    expect(GRAPHQL_OVER_HTTP_REPAIR).toContain("cursor_pagination");
  });
});
