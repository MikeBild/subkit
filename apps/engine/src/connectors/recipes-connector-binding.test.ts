import { describe, expect, test } from "bun:test";
import { compileRequestBoundary } from "../workflows/request-boundary.ts";
import type { RequestStep } from "../workflows/types.ts";
import { bindRecipe } from "./recipe-binding.ts";
import { getBuiltinTemplate, loadBuiltinTemplates } from "./templates.ts";

type StepNode = { kind?: string; id?: string; url?: string; path?: string; connector_id?: string };

const collectSteps = (nodes: unknown): StepNode[] =>
  Array.isArray(nodes)
    ? nodes.flatMap(collectSteps)
    : nodes !== null && typeof nodes === "object"
      ? [
          ...("kind" in nodes ? [nodes as StepNode] : []),
          ...Object.values(nodes).flatMap(collectSteps),
        ]
      : [];

const stockRecipes = loadBuiltinTemplates().flatMap((template) =>
  template.recipes.map((recipe) => ({
    template,
    recipe,
    name: `${template.slug}/${recipe.slug}`,
    steps: collectSteps(recipe.workflow.steps),
  })),
);
const singleConnectorPlaceholder = "00000000-0000-0000-0000-000000000000";
const templateSlugs = new Set(loadBuiltinTemplates().map((template) => template.slug));

describe("stock recipe connector binding (#537, #544)", () => {
  test("no stock recipe step addresses a connector through a base_url placeholder url", () => {
    const offenders = stockRecipes.flatMap(({ name, steps }) =>
      steps
        .filter((step) => step.url?.includes("${connector."))
        .map((step) => `${name}/${step.id}: ${step.url}`),
    );
    expect(offenders).toEqual([]);
  });

  test("every relative path step binds a connector declared in required_connectors", () => {
    const offenders = stockRecipes.flatMap(({ name, recipe, steps }) => {
      const placeholders = new Set(recipe.required_connectors.map((entry) => entry.placeholder));
      return steps
        .filter((step) => step.kind === "request" && step.path)
        .filter((step) => !step.connector_id || !placeholders.has(step.connector_id))
        .map((step) => `${name}/${step.id}: ${step.path}`);
    });
    expect(offenders).toEqual([]);
  });

  test("every multi-connector placeholder is declared in required_connectors", () => {
    const offenders = stockRecipes.flatMap(({ name, recipe, steps }) => {
      const placeholders = new Set(recipe.required_connectors.map((entry) => entry.placeholder));
      return steps
        .filter((step) => step.connector_id && step.connector_id !== singleConnectorPlaceholder)
        .filter((step) => !placeholders.has(step.connector_id!))
        .map((step) => `${name}/${step.id}: ${step.connector_id}`);
    });
    expect(offenders).toEqual([]);
  });

  test("every required connector names a builtin template and is used by a step", () => {
    const offenders = stockRecipes.flatMap(({ name, recipe, steps }) => {
      const boundIds = new Set(steps.map((step) => step.connector_id));
      return recipe.required_connectors
        .filter((entry) => !templateSlugs.has(entry.template) || !boundIds.has(entry.placeholder))
        .map((entry) => `${name}: ${entry.template} ${entry.placeholder}`);
    });
    expect(offenders).toEqual([]);
  });

  test("notion and airtable steps bind their own connector and resolve to its credentialed connector", () => {
    const outcomes = ["notion", "airtable"].flatMap((slug) => {
      const template = getBuiltinTemplate(slug)!;
      const connector = {
        id: `11111111-1111-4111-8111-${slug === "notion" ? "000000000001" : "000000000002"}`,
        slug,
        display_name: template.name,
        template_slug: slug,
        enabled: true,
      };
      const templates = new Map([[slug, { name: template.name, base_url: template.base_url }]]);
      return template.recipes.flatMap((recipe) => {
        const bound = bindRecipe(recipe, [connector], templates);
        return (bound.workflow.steps as RequestStep[])
          .filter((step) => step.kind === "request")
          .map((step) => ({
            name: `${slug}/${recipe.slug}/${step.id}`,
            template_slug: slug,
            required: recipe.required_connectors.map((entry) => [
              entry.placeholder,
              entry.template,
            ]),
            connector_id: step.connector_id,
            url: step.url ?? null,
            partial_segment:
              compileRequestBoundary(
                {
                  ...step,
                  boundary: { variables: {}, max_body_bytes: 4096, max_calls: 1 },
                },
                template.base_url,
              ).refusal === "partial_segment_placeholder",
            expected_connector_id: connector.id,
          }));
      });
    });
    expect(outcomes.length).toBeGreaterThanOrEqual(15);
    expect(outcomes).toEqual(
      outcomes.map((outcome) => ({
        ...outcome,
        required: [[singleConnectorPlaceholder, outcome.template_slug]],
        connector_id: outcome.expected_connector_id,
        url: null,
        partial_segment: false,
      })),
    );
  });
});
