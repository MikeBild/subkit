import { describe, expect, test } from "bun:test";
import { getSolutionRecipe } from "../connectors/solutions.ts";
import { getBuiltinTemplate } from "../connectors/templates.ts";
import { gateRequestBoundary } from "./effect-resolution.ts";
import { mailboxInstallInputs, pinInstallInputs } from "./recipe-install-inputs.ts";
import { pinnedRecipeDefinition, recipeDeliveryBinding } from "./recipe-origin.ts";
import { type RequestStep, type WorkflowDef, WorkflowDefSchema } from "./types.ts";

const paidCheckout = () => {
  const recipe = getSolutionRecipe("payment-grants-access");
  if (!recipe) throw new Error("payment-grants-access missing");
  return recipe;
};

const paidOrigin = { vertical: "solutions", slug: "payment-grants-access" };

describe("install-time sender of the paid checkout solution (#590)", () => {
  test("the engine accepts a sender already pinned by the CLI", () => {
    const inputs = { sender: "team@example.com" };
    const cli = pinInstallInputs(paidCheckout().workflow, paidCheckout().install_inputs, inputs);
    if (!cli.ok) throw new Error(cli.message);
    expect(pinnedRecipeDefinition({ ...paidOrigin, inputs }, cli.definition)).toEqual(cli);
  });

  test("the solution declares its sender as an install input of the mailbox class", () => {
    expect(paidCheckout().install_inputs).toEqual(["sender"]);
    expect(mailboxInstallInputs(paidCheckout().workflow, ["sender"])).toEqual(["sender"]);
    expect(mailboxInstallInputs(analytics().workflow, analytics().install_inputs)).toEqual([]);
  });

  test("the sender lands literally in the delivery profile and the mail builder", () => {
    const pinned = pinnedRecipeDefinition(
      { ...paidOrigin, inputs: { sender: "team@example.com" } },
      paidCheckout().workflow,
    );
    if (!pinned.ok) throw new Error(pinned.message);
    const parsed = WorkflowDefSchema.parse(pinned.definition);
    const send = parsed.steps.find((step) => step.id === "send_welcome") as RequestStep;
    expect(send.transactional_delivery?.from).toBe("team@example.com");
    const settings = parsed.steps.find((step) => step.id === "settings");
    expect(settings && "expression" in settings ? settings.expression : null).toContain(
      "sender: 'team@example.com'",
    );
    expect(JSON.stringify(pinned.definition)).not.toContain("install-input.invalid");
  });

  test("a missing or malformed sender is refused and never spliced", () => {
    expect(pinnedRecipeDefinition(paidOrigin, paidCheckout().workflow)).toMatchObject({
      ok: false,
      reason: "recipe_input_missing",
    });
    for (const sender of ["o'hara@example.com", "team@example.com\nBcc: x@example.com", "", 42])
      expect(
        pinnedRecipeDefinition({ ...paidOrigin, inputs: { sender } }, paidCheckout().workflow),
      ).toEqual({
        ok: false,
        reason: "recipe_input_invalid",
        message:
          "install input sender of recipe solutions/payment-grants-access must be one plain email address of the sending mailbox",
      });
  });

  test("a recipe install binds every transactional delivery to one new binding of its own", () => {
    const delivery = recipeDeliveryBinding(paidCheckout().workflow);
    if (!delivery) throw new Error("the paid checkout has no transactional delivery");
    const send = (delivery.definition as WorkflowDef).steps.find(
      (step) => step.id === "send_welcome",
    ) as RequestStep;
    expect(send.transactional_delivery?.webhook_id).toBe(delivery.binding_id);
    expect(JSON.stringify(paidCheckout().workflow)).not.toContain(delivery.binding_id);
    expect(recipeDeliveryBinding(analytics().workflow)).toBeNull();
  });
});

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
