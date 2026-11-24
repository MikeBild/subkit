import { describe, expect, test } from "bun:test";
import type { RequestStep } from "../workflows/types.ts";
import { bindRecipe } from "./recipe-binding.ts";
import { getBuiltinTemplate } from "./templates.ts";

describe("google-analytics report recipes (#584)", () => {
  const placeholder = "00000000-0000-0000-0000-000000000000";
  const analytics = getBuiltinTemplate("google-analytics")!;
  const requestSteps = (steps: unknown[]): RequestStep[] =>
    (steps as RequestStep[]).filter((step) => step.kind === "request");

  test("every request step addresses the google-analytics connector by id and path", () => {
    const outcomes = analytics.recipes.flatMap((recipe) =>
      requestSteps(recipe.workflow.steps).map((step) => ({
        step: `${recipe.slug}/${step.id}`,
        connector_id: step.connector_id,
        has_path: typeof step.path === "string" && step.path.startsWith("/v1beta/properties/"),
        url: step.url ?? null,
        required: recipe.required_connectors.find((r) => r.placeholder === placeholder)?.template,
      })),
    );
    expect(outcomes.map((outcome) => outcome.step).sort()).toEqual([
      "realtime-active-users/realtime",
      "run-report/totals",
      "top-pages/pages",
      "traffic-sources/sources",
    ]);
    expect(outcomes).toEqual(
      outcomes.map((outcome) => ({
        ...outcome,
        connector_id: placeholder,
        has_path: true,
        url: null,
        required: "google-analytics",
      })),
    );
  });

  test("binding one enabled google-analytics connector rebinds every request step to it", () => {
    const connectorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const templates = new Map([
      ["google-analytics", { name: "Google Analytics 4", base_url: analytics.base_url }],
    ]);
    const connector = {
      id: connectorId,
      slug: "ga4",
      display_name: "GA4",
      template_slug: "google-analytics",
      enabled: true,
    };
    const outcomes = analytics.recipes.map((recipe) => ({
      slug: recipe.slug,
      ids: requestSteps(bindRecipe(recipe, [connector], templates).workflow.steps).map(
        (step) => step.connector_id,
      ),
    }));
    expect(outcomes).toEqual(outcomes.map((outcome) => ({ ...outcome, ids: [connectorId] })));
  });
});
