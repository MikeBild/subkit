import { describe, expect, test } from "bun:test";
import { getSolutionRecipe } from "../connectors/solutions.ts";
import { getBuiltinTemplate } from "../connectors/templates.ts";
import { gateRequestBoundary } from "./effect-resolution.ts";
import { pinInstallInputs } from "./recipe-install-inputs.ts";
import { pinnedRecipeDefinition } from "./recipe-origin.ts";
import type { RequestStep, WorkflowDef } from "./types.ts";

const analytics = () => {
  const recipe = getSolutionRecipe("daily-analytics-report");
  if (!recipe) throw new Error("daily-analytics-report missing");
  return recipe;
};

const analyticsSteps = (definition: unknown) =>
  ((definition as WorkflowDef).steps as RequestStep[]).filter(
    (step) =>
      step.kind === "request" &&
      step.connector_id === analytics().required_connectors[0]?.placeholder,
  );

const gateRefusals = (definition: unknown) =>
  Promise.all(
    analyticsSteps(definition).map(async (step) => ({
      step: step.id,
      refusal: (
        await gateRequestBoundary({
          step,
          system: null,
          credentials: undefined,
          stricter_profile: null,
          read_path: false,
        })
      ).refusal,
    })),
  );

describe("install-time inputs pinned into recipe request paths (#519)", () => {
  test("the analytics recipes declare the property id as an install input", () => {
    expect(analytics().install_inputs).toEqual(["property_id"]);
    const ga4 = getBuiltinTemplate("google-analytics");
    expect(ga4?.recipes.map((recipe) => [recipe.slug, recipe.install_inputs])).toEqual([
      ["run-report", ["property_id"]],
      ["top-pages", ["property_id"]],
      ["traffic-sources", ["property_id"]],
      ["realtime-active-users", ["property_id"]],
    ]);
  });

  test("a pinned property id leaves literal paths that pass the request boundary gate", async () => {
    const pinned = pinInstallInputs(analytics().workflow, analytics().install_inputs, {
      property_id: "123456789",
      recipient: "team@example.com",
    });
    if (!pinned.ok) throw new Error(pinned.message);
    expect(analyticsSteps(pinned.definition).map((step) => step.path)).toEqual([
      "/v1beta/properties/123456789:runReport",
      "/v1beta/properties/123456789:runReport",
    ]);
    expect(await gateRefusals(pinned.definition)).toEqual([
      { step: "totals", refusal: null },
      { step: "top_pages", refusal: null },
    ]);
    expect(analyticsSteps(analytics().workflow)[0]?.path).toBe(
      "/v1beta/properties/${input.property_id}:runReport",
    );
  });

  test("without a pinned property id the gate still refuses the partial segment", async () => {
    const unpinned = pinInstallInputs(analytics().workflow, analytics().install_inputs, {});
    if (!unpinned.ok) throw new Error(unpinned.message);
    expect(await gateRefusals(unpinned.definition)).toEqual([
      { step: "totals", refusal: "partial_segment_placeholder" },
      { step: "top_pages", refusal: "partial_segment_placeholder" },
    ]);
  });

  test("a value that is not one plain path segment is refused, never spliced", () => {
    for (const property_id of ["1/../2", "", "12 34", "a%2F", "${input.other}", { id: 1 }]) {
      expect(
        pinInstallInputs(analytics().workflow, ["property_id"], { property_id }),
      ).toMatchObject({ ok: false, key: "property_id" });
    }
    const numeric = pinInstallInputs(analytics().workflow, ["property_id"], { property_id: 42 });
    expect(numeric.ok && analyticsSteps(numeric.definition)[0]?.path).toBe(
      "/v1beta/properties/42:runReport",
    );
  });

  test("a recipe origin with inputs yields the pinned definition; without inputs it is unchanged", () => {
    const origin = { vertical: "solutions", slug: "daily-analytics-report" };
    const pinned = pinnedRecipeDefinition(
      { ...origin, inputs: { property_id: "987654321" } },
      analytics().workflow,
    );
    expect(pinned.ok && analyticsSteps(pinned.definition)[1]?.path).toBe(
      "/v1beta/properties/987654321:runReport",
    );
    expect(pinnedRecipeDefinition(origin, analytics().workflow)).toEqual({
      ok: true,
      definition: analytics().workflow,
    });
    expect(
      pinnedRecipeDefinition({ ...origin, inputs: { property_id: "../x" } }, analytics().workflow),
    ).toEqual({
      ok: false,
      reason: "recipe_input_invalid",
      message:
        "install input property_id of recipe solutions/daily-analytics-report must be one plain path segment of letters, digits, _ or -",
    });
  });
});
