import { describe, expect, test } from "bun:test";
import { workflowsCommand } from "../commands/workflows.ts";
import { createBodyFor, type RecipePackEntry, recipeWorkflowSource } from "./recipe-source.ts";

const SLACK = "54000000-0000-4000-8000-000000000001";

function entry(connector_id: string | null): RecipePackEntry {
  return {
    template_slug: null,
    recipe_slug: "webhook-to-slack",
    title: "Check incoming events and post the important ones to Slack",
    description: "Posts important events into one Slack channel.",
    category: "communication",
    tags: [],
    difficulty: "beginner",
    connectors: [
      {
        placeholder: SLACK,
        template: "slack",
        template_name: "Slack",
        connector_id,
        connector_name: connector_id ? "Team Slack" : null,
      },
    ],
    sample_input: { level: "error", title: "Down" },
    workflow: { name: "webhook-to-slack", steps: [{ id: "post", connector_id: connector_id }] },
  };
}

const pack = (connector_id: string | null) => ({
  recipes: [entry(connector_id)] as unknown as Record<string, unknown>[],
});

describe("sk workflows create --from-recipe", () => {
  test("a bound solution yields its workflow, its sample input as preview input and its origin", () => {
    const source = recipeWorkflowSource(
      pack("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      "webhook-to-slack",
    );
    expect(source.previewInput).toEqual({ level: "error", title: "Down" });
    expect(source.recipe).toEqual({ vertical: "solutions", slug: "webhook-to-slack" });
    expect(createBodyFor(source)).toEqual({
      name: "webhook-to-slack",
      steps: [{ id: "post", connector_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }],
      recipe: { vertical: "solutions", slug: "webhook-to-slack" },
    });
  });

  test("a solution with a missing connector names it and how to create it", () => {
    expect(() => recipeWorkflowSource(pack(null), "webhook-to-slack")).toThrow(
      'solution "webhook-to-slack" needs a connector for Slack (sk connectors create --template slack)',
    );
  });

  test("an unknown slug lists the solutions that exist", () => {
    expect(() => recipeWorkflowSource(pack(null), "made-up")).toThrow(
      'no solution recipe "made-up"; available: webhook-to-slack',
    );
  });

  test("a file source sends its body unchanged", () => {
    const body = { name: "from-file", steps: [] };
    expect(createBodyFor({ body, previewInput: null, recipe: null })).toBe(body);
  });

  test("create takes --file or --from-recipe, update still requires --file", () => {
    const sub = workflowsCommand.subCommands as Record<
      string,
      { args: Record<string, { required?: boolean }> }
    >;
    expect(sub.create?.args["from-recipe"]).toBeDefined();
    expect(sub.create?.args.file?.required).toBeUndefined();
    expect(sub.update?.args.file?.required).toBe(true);
    expect(sub.update?.args["from-recipe"]).toBeUndefined();
  });
});
