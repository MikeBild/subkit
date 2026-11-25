import { describe, expect, test } from "bun:test";
import { workflowsCommand } from "../commands/workflows.ts";
import {
  createBodyFor,
  parseBinds,
  type RecipePackEntry,
  recipeWorkflowSource,
} from "./recipe-source.ts";

const SLACK = "54000000-0000-4000-8000-000000000001";

type Candidate = RecipePackEntry["connectors"][number]["candidates"][number];

function recipeWorkflow(shape: {
  name: string;
  steps: { id: string; connector_id: string }[];
}): RecipePackEntry["workflow"] {
  return shape as unknown as RecipePackEntry["workflow"];
}

function entry(connector_id: string | null, candidates: Candidate[] = []): RecipePackEntry {
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
        candidates,
      },
    ],
    sample_input: { level: "error", title: "Down" },
    workflow: recipeWorkflow({
      name: "webhook-to-slack",
      steps: [{ id: "post", connector_id: connector_id ?? SLACK }],
    }),
  };
}

const pack = (connector_id: string | null, candidates: Candidate[] = []) => ({
  recipes: [entry(connector_id, candidates)] as unknown as Record<string, unknown>[],
});

describe("subkit workflows create --from-recipe", () => {
  test("recipe preview keeps omitted input distinct from explicit null", () => {
    const missing = entry(SLACK);
    Reflect.deleteProperty(missing, "sample_input");
    expect(
      recipeWorkflowSource(
        { recipes: [missing] as unknown as Record<string, unknown>[] },
        "webhook-to-slack",
      ).previewInput,
    ).toBeUndefined();
    expect(
      recipeWorkflowSource(
        {
          recipes: [{ ...entry(SLACK), sample_input: null }] as unknown as Record<
            string,
            unknown
          >[],
        },
        "webhook-to-slack",
      ).previewInput,
    ).toBeNull();
  });

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

  test("an explicit install input travels with the origin so the engine pins it (#519)", () => {
    const source = recipeWorkflowSource(
      pack("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      "webhook-to-slack",
    );
    expect(createBodyFor(source, { property_id: "123456789" }).recipe).toEqual({
      vertical: "solutions",
      slug: "webhook-to-slack",
      inputs: { property_id: "123456789" },
    });
    for (const input of [undefined, null, ["123"], "123"])
      expect(createBodyFor(source, input).recipe).toEqual({
        vertical: "solutions",
        slug: "webhook-to-slack",
      });
  });

  test("a solution with a missing connector names it, how to bind it and how to create it", () => {
    expect(() => recipeWorkflowSource(pack(null), "webhook-to-slack")).toThrow(
      'solution "webhook-to-slack" needs a connector — Slack: --bind slack=<connector id or slug>, or subkit connectors create --template slack',
    );
  });

  test("two candidates are never picked silently; both are named", () => {
    const candidates = [
      { id: "11111111-1111-4111-8111-111111111111", slug: "slack-sales", name: "Sales" },
      { id: "22222222-2222-4222-8222-222222222222", slug: "slack-ops", name: "Ops" },
    ];
    expect(() => recipeWorkflowSource(pack(null, candidates), "webhook-to-slack")).toThrow(
      "Slack: choose one of slack-sales, slack-ops with --bind slack=<connector id or slug>",
    );
  });

  test("--bind fills a missing connector by template or placeholder, by id or slug", () => {
    const known = [
      { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", slug: "team-slack", template_slug: "slack" },
    ];
    for (const binds of [{ slack: "team-slack" }, { [SLACK]: known[0]?.id ?? "" }]) {
      const source = recipeWorkflowSource(pack(null), "webhook-to-slack", binds, known);
      expect(source.body.steps).toEqual([
        { id: "post", connector_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      ]);
    }
  });

  test("--bind overrides an automatic binding and refuses an unknown connector", () => {
    const known = [
      { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", slug: "other-slack", template_slug: "slack" },
      {
        id: "99999999-9999-4999-8999-999999999999",
        slug: "team-mail",
        template_slug: "google-gmail",
      },
    ];
    const source = recipeWorkflowSource(
      pack("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      "webhook-to-slack",
      { slack: "other-slack" },
      known,
    );
    expect(source.body.steps).toEqual([
      { id: "post", connector_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    ]);
    expect(() =>
      recipeWorkflowSource(pack(null), "webhook-to-slack", { slack: "nope" }, known),
    ).toThrow('--bind names no connector "nope"');
    expect(() =>
      recipeWorkflowSource(pack(null), "webhook-to-slack", { slack: "team-mail" }, known),
    ).toThrow("--bind slack=team-mail: that connector is a google-gmail connector, not Slack");
    expect(() =>
      recipeWorkflowSource(pack(null), "webhook-to-slack", { stripe: "other-slack" }, known),
    ).toThrow(
      '--bind names "stripe", which solution "webhook-to-slack" does not use; it needs: slack',
    );
  });

  test("--bind reads comma-separated pairs and refuses a malformed one", () => {
    expect(parseBinds(undefined)).toEqual({});
    expect(parseBinds("http=own-api, stripe = stripe-prod")).toEqual({
      http: "own-api",
      stripe: "stripe-prod",
    });
    expect(() => parseBinds("http")).toThrow("--bind expects");
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
