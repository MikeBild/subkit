import { describe, expect, test } from "bun:test";
import { loadBuiltinTemplates } from "../templates.ts";

const linear = loadBuiltinTemplates().find((template) => template.slug === "linear");
const graphqlQueries = (linear?.recipes ?? [])
  .flatMap((recipe) => recipe.workflow.steps)
  .map((step) => (step as { graphql?: { query?: string } }).graphql?.query ?? "")
  .filter(Boolean);

describe("Linear connector template", () => {
  test("declares team(id:) variables as String! (#546)", () => {
    const teamQueries = graphqlQueries.filter((query) => /team\(id:\s*\$\w+/.test(query));
    expect(teamQueries.length).toBeGreaterThanOrEqual(2);
    for (const query of teamQueries) {
      const variableName = query.match(/team\(id:\s*\$(\w+)/)?.[1];
      expect(query).toMatch(new RegExp(`\\$${variableName}\\s*:\\s*String!`));
    }
  });
});
