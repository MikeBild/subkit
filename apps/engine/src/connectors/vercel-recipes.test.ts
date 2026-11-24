import { describe, expect, test } from "bun:test";
import { supportsReadQuery } from "../workflows/report-delivery-boundary.ts";
import { compileRequestBoundary, requestBoundaryViolation } from "../workflows/request-boundary.ts";
import type { RequestStep } from "../workflows/types.ts";
import { bindRecipe } from "./recipe-binding.ts";
import { getBuiltinTemplate } from "./templates.ts";

describe("vercel recipes (#585)", () => {
  const placeholder = "00000000-0000-0000-0000-000000000000";
  const vercel = getBuiltinTemplate("vercel")!;
  const stepOf = (slug: string): RequestStep =>
    vercel.recipes.find((recipe) => recipe.slug === slug)!.workflow.steps[0] as RequestStep;
  const violationFor = (slug: string, url: string) =>
    requestBoundaryViolation(compileRequestBoundary(stepOf(slug), vercel.base_url).boundary!, {
      method: "GET",
      url,
      headers: {},
      body: null,
    });

  test("every vercel request step binds the vercel connector and compiles a request boundary", () => {
    const outcomes = vercel.recipes.flatMap((recipe) =>
      (recipe.workflow.steps as RequestStep[]).map((step) => ({
        step: `${recipe.slug}/${step.id}`,
        connector_id: step.connector_id,
        url: step.url ?? null,
        required: recipe.required_connectors.find((r) => r.placeholder === placeholder)?.template,
        refusal: step.boundary
          ? (compileRequestBoundary(step, vercel.base_url).refusal ?? null)
          : supportsReadQuery(step)
            ? null
            : "no_boundary",
      })),
    );
    expect(outcomes.map((outcome) => outcome.step).sort()).toEqual([
      "get-deployment/deployment",
      "list-deployments/deployments",
      "list-projects/projects",
    ]);
    expect(outcomes).toEqual(
      outcomes.map((outcome) => ({
        ...outcome,
        connector_id: placeholder,
        url: null,
        required: "vercel",
        refusal: null,
      })),
    );
  });

  test("binding replaces the placeholder with the one enabled vercel connector", () => {
    const chosen = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const templates = new Map([["vercel", { name: vercel.name, base_url: vercel.base_url }]]);
    const row = {
      id: chosen,
      slug: "vercel",
      display_name: "Vercel",
      template_slug: "vercel",
      enabled: true,
    };
    const boundIds = vercel.recipes.flatMap((recipe) =>
      (bindRecipe(recipe, [row], templates).workflow.steps as RequestStep[]).map(
        (step) => step.connector_id,
      ),
    );
    expect(boundIds).toEqual([chosen, chosen, chosen]);
  });

  test("the bound boundaries admit the requests the recipes send", () => {
    expect([
      violationFor("list-projects", "https://api.vercel.com/v10/projects"),
      violationFor("get-deployment", "https://api.vercel.com/v13/deployments/dpl_89qyp1cskzkLrVic"),
      violationFor(
        "get-deployment",
        "https://api.vercel.com/v13/deployments/my-app-git-main-team.vercel.app",
      ),
    ]).toEqual([null, null, null]);
  });
});
