import { describe, expect, test } from "bun:test";
import { loadBuiltinTemplates } from "../templates.ts";

const linearRecipes =
  loadBuiltinTemplates().find((template) => template.slug === "linear")?.recipes ?? [];
const graphqlQueriesOf = (recipeSlug: string) =>
  (linearRecipes.find((recipe) => recipe.slug === recipeSlug)?.workflow.steps ?? [])
    .map((step) => (step as { graphql?: { query?: string } }).graphql?.query ?? "")
    .filter(Boolean);
const teamQueries = linearRecipes
  .flatMap((recipe) => graphqlQueriesOf(recipe.slug))
  .filter((query) => /team\(id:\s*\$\w+/.test(query));
const teamVariableType = (query: string) => {
  const variableName = query.match(/team\(id:\s*\$(\w+)/)?.[1] ?? "";
  return query.match(new RegExp(`\\$${variableName}\\s*:\\s*([\\w!\\[\\]]+)`))?.[1];
};

describe("Linear connector template", () => {
  test.each(["list-issues", "list-cycles"])(
    "%s declares the team(id:) variable as String! (#546)",
    (recipeSlug) => {
      const queries = graphqlQueriesOf(recipeSlug).filter((query) => /team\(id:/.test(query));
      expect(queries).toHaveLength(1);
      expect(teamVariableType(queries[0] ?? "")).toBe("String!");
    },
  );

  test("no Linear recipe passes an ID! variable to team(id:) (#546)", () => {
    expect(teamQueries.length).toBeGreaterThanOrEqual(2);
    expect(teamQueries.map(teamVariableType)).toEqual(teamQueries.map(() => "String!"));
  });
});
