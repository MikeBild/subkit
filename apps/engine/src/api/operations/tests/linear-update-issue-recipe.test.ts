import { describe, expect, test } from "bun:test";
import { loadBuiltinTemplates } from "../../../connectors/templates.ts";
import type { Db } from "../../../db/client.ts";
import { resolvePlaceholdersTypePreserving } from "../../../llm/substitution/resolver.ts";

type GraphqlStep = { graphql: { query: string; variables: Record<string, unknown> } };
type JsonSchema = {
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  minProperties?: number;
};

const linearUpdateIssue = () => {
  const recipe = loadBuiltinTemplates()
    .find((template) => template.slug === "linear")
    ?.recipes.find((candidate) => candidate.slug === "update-issue");
  if (!recipe) throw new Error("builtin recipe linear/update-issue is missing");
  const workflow = recipe.workflow as { input_schema: JsonSchema; steps: GraphqlStep[] };
  return { recipe, schema: workflow.input_schema, step: workflow.steps[0]! };
};

describe("linear update-issue recipe", () => {
  test("input accepts title, description and stateId as optional changes", () => {
    const { schema } = linearUpdateIssue();
    expect(schema.required).toEqual(["issue_id", "changes"]);
    const changes = schema.properties?.changes;
    expect(Object.keys(changes?.properties ?? {}).sort()).toEqual([
      "description",
      "stateId",
      "title",
    ]);
    expect(changes?.additionalProperties).toBe(false);
    expect(changes?.minProperties).toBe(1);
  });

  test("mutation sends the whole IssueUpdateInput and returns url and identifier", () => {
    const { recipe, step } = linearUpdateIssue();
    expect(step.graphql.query).toContain("$input:IssueUpdateInput!");
    expect(step.graphql.query).toContain("issueUpdate(id:$id, input:$input)");
    expect(step.graphql.query).toMatch(/issue \{[^}]*\bidentifier\b[^}]*\burl\b/);
    expect(step.graphql.variables).toEqual({ id: "${input.issue_id}", input: "${input.changes}" });
    expect(recipe.description).toContain("stateId");
  });

  test("a state-only change resolves to { stateId } without a title", async () => {
    const { step } = linearUpdateIssue();
    const resolved = await resolvePlaceholdersTypePreserving(step.graphql.variables, {
      tenant_id: "t",
      environment: "dev",
      db: {} as Db,
      input: { issue_id: "ISS-1", changes: { stateId: "state-done" } },
    });
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.value).toEqual({ id: "ISS-1", input: { stateId: "state-done" } });
  });
});
