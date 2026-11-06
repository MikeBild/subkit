import { describe, expect, test } from "bun:test";
import { countTokens } from "../../accounting/index.ts";
import {
  formatConnectorRecipeBodies,
  RECIPE_BODIES_SECTION_CAP,
  RECIPE_BODY_HYBRID_SOFT_CAP,
  type RecipeBodyView,
  renderRecipeBody,
} from "../context-assembler/formatters.ts";
import { loadTopRecipeBodies, trimRecipeBodiesToBudget } from "../context-assembler/loaders.ts";

function makeRecipe(overrides: Partial<RecipeBodyView> = {}): RecipeBodyView {
  return {
    template_slug: "stripe",
    recipe_slug: "stripe-charge-succeeded",
    title: "Handle Stripe charge succeeded",
    description: "Trigger a workflow when a Stripe charge.succeeded webhook arrives.",
    prerequisites: ["Stripe connector configured", "Webhook endpoint registered"],
    required_connectors: [
      { placeholder: "stripe", template: "stripe" },
      { placeholder: "slack", template: "slack" },
    ],
    sample_input: { event: "charge.succeeded", amount: 5000 },
    workflow: {
      name: "stripe-charge-succeeded",
      steps: [
        {
          id: "notify",
          kind: "request",
          connector_id: `\${slack}`,
          path: "/chat.postMessage",
          params: { channel: "#payments", text: `New charge: \${scope.trigger.amount}` },
        },
      ],
    },
    ...overrides,
  };
}

describe("formatConnectorRecipeBodies — payload", () => {
  test("AC1: section includes description + prerequisites + required_connectors + sample_input + workflow JSON", () => {
    const recipe = makeRecipe();
    const section = formatConnectorRecipeBodies("stripe", [recipe]);
    expect(section).not.toBeNull();

    expect(section).toContain("Trigger a workflow when a Stripe charge.succeeded webhook");

    expect(section).toContain("Prerequisites:");
    expect(section).toContain("Stripe connector configured");

    expect(section).toContain("Required connectors:");
    expect(section).toContain("stripe");
    expect(section).toContain("slack");

    expect(section).toContain("Sample input:");
    expect(section).toContain("charge.succeeded");

    expect(section).toContain("```json");
    expect(section).toContain("stripe-charge-succeeded");
  });

  test("AC3: rendered section contains workflow JSON fence for small recipe", () => {
    const recipe = makeRecipe();
    const { text, fellBack } = renderRecipeBody(recipe);
    expect(fellBack).toBe(false);
    expect(text).toContain("```json");
    expect(text).toContain("stripe-charge-succeeded");
  });

  test("section starts with heading containing connector slug", () => {
    const section = formatConnectorRecipeBodies("stripe", [makeRecipe()]);
    expect(section).not.toBeNull();
    expect(section!.startsWith("# Recipe bodies — connector `stripe`")).toBe(true);
  });

  test("returns null when given an empty array", () => {
    expect(formatConnectorRecipeBodies("stripe", [])).toBeNull();
  });

  test("single-connector recipe renders as 'single-connector recipe'", () => {
    const recipe = makeRecipe({ required_connectors: [] });
    const { text } = renderRecipeBody(recipe);
    expect(text).toContain("single-connector recipe");
  });
});

describe("trimRecipeBodiesToBudget — 2000-token cap", () => {
  test("AC2: a single normal recipe fits without trimming", () => {
    const recipe = makeRecipe();
    const result = trimRecipeBodiesToBudget("stripe", [recipe]);
    expect(result.trimmed).toBe(0);
    expect(result.section).not.toBeNull();
    const tokens = countTokens(result.section!);
    expect(tokens).toBeLessThanOrEqual(RECIPE_BODIES_SECTION_CAP);
  });

  test("AC2: 50 large recipes → section ≤ 2000 tokens with elision notice", () => {
    const bigWorkflow = {
      name: "big",
      steps: Array.from({ length: 20 }, (_, i) => ({
        id: `step-${i}`,
        kind: "request",
        connector_id: `\${stripe}`,
        path: `/v1/charges/${i}`,
        params: { amount: i * 100, currency: "usd", description: `step ${i} description` },
      })),
    };
    const recipes = Array.from({ length: 50 }, (_, i) =>
      makeRecipe({ recipe_slug: `recipe-${i}`, workflow: bigWorkflow }),
    );
    const result = trimRecipeBodiesToBudget("stripe", recipes);
    if (result.section !== null) {
      const tokens = countTokens(result.section);
      expect(tokens).toBeLessThanOrEqual(RECIPE_BODIES_SECTION_CAP);
      if (result.trimmed > 0) {
        expect(result.section).toContain("elided — token budget");
      }
    } else {
      expect(result.trimmed).toBeGreaterThan(0);
    }
  });

  test("AC2: elision notice present when trimmed > 0", () => {
    const bigWorkflow = {
      name: "big",
      steps: Array.from({ length: 30 }, (_, i) => ({
        id: `s${i}`,
        kind: "request",
        connector_id: `\${c}`,
        path: `/v1/items/${i}`,
        params: { key: `value-${i}-${"x".repeat(50)}` },
      })),
    };
    const recipes = Array.from({ length: 5 }, (_, i) =>
      makeRecipe({ recipe_slug: `big-${i}`, workflow: bigWorkflow }),
    );
    const result = trimRecipeBodiesToBudget("stripe", recipes);
    if (result.trimmed > 0 && result.section !== null) {
      expect(result.section).toContain("elided — token budget");
    }
  });
});

describe("renderRecipeBody — 800-token hybrid fallback", () => {
  test("D3: recipe under 800 tokens renders with workflow JSON (no fallback)", () => {
    const recipe = makeRecipe();
    const { fellBack } = renderRecipeBody(recipe);
    expect(fellBack).toBe(false);
  });

  test("D3: recipe over 800 tokens falls back to hybrid — elides workflow but keeps required_connectors", () => {
    const hugeWorkflow = {
      name: "huge",
      metadata: "x".repeat(3000),
      steps: Array.from({ length: 50 }, (_, i) => ({
        id: `step-${i}`,
        kind: "request",
        connector_id: `\${stripe}`,
        path: `/v1/items/${i}`,
        description: `${"A very long description of step ".repeat(5)}${i}`,
        params: { key: `value-${i}-${"data".repeat(20)}` },
      })),
    };
    const recipe = makeRecipe({ workflow: hugeWorkflow });
    const { text, fellBack } = renderRecipeBody(recipe);

    expect(fellBack).toBe(true);

    expect(text).toContain("workflow body elided");
    expect(text).toContain("inspect_recipe");

    expect(text).toContain("Required connectors:");
    expect(text).toContain("stripe");
    expect(text).toContain("slack");

    expect(text).not.toContain("A very long description of step");
    expect(text).not.toContain("step-25");
  });

  test("D3: hybrid path keeps description + prerequisites + sample_input", () => {
    const hugeWorkflow = { name: "huge", data: "x".repeat(4000) };
    const recipe = makeRecipe({ workflow: hugeWorkflow });
    const { text, fellBack } = renderRecipeBody(recipe);

    if (fellBack) {
      expect(text).toContain("Trigger a workflow when a Stripe charge.succeeded webhook");
      expect(text).toContain("Prerequisites:");
      expect(text).toContain("Stripe connector configured");
      expect(text).toContain("Sample input:");
    }
  });

  test("D3: hybrid fallback cap is RECIPE_BODY_HYBRID_SOFT_CAP", () => {
    expect(RECIPE_BODY_HYBRID_SOFT_CAP).toBe(800);
  });
});

describe("loadTopRecipeBodies — pure ranking over snapshot", () => {
  function makeSnapshot(recipes: unknown[]): Record<string, unknown> {
    return { slug: "stripe", recipes };
  }

  const RECIPE_A = {
    slug: "charge-succeeded",
    title: "Handle charge succeeded",
    description: "Fires when a charge succeeds.",
    intent_keywords: ["charge", "payment", "succeeded"],
    tags: ["billing"],
    prerequisites: [],
    required_connectors: [],
    sample_input: null,
    workflow: { name: "charge-succeeded", steps: [] },
  };
  const RECIPE_B = {
    slug: "refund-issued",
    title: "Handle refund issued",
    description: "Fires when a refund is issued.",
    intent_keywords: ["refund", "billing"],
    tags: ["billing"],
    prerequisites: [],
    required_connectors: [],
    sample_input: null,
    workflow: { name: "refund-issued", steps: [] },
  };

  test("returns empty for null snapshot", () => {
    expect(loadTopRecipeBodies(null, undefined, "", 3)).toHaveLength(0);
  });

  test("returns empty when snapshot has no recipes", () => {
    expect(loadTopRecipeBodies({ slug: "stripe", recipes: [] }, undefined, "", 3)).toHaveLength(0);
  });

  test("returns top 3 recipes in ranked order", () => {
    const snapshot = makeSnapshot([
      RECIPE_A,
      RECIPE_B,
      { ...RECIPE_A, slug: "extra", workflow: {} },
    ]);
    const result = loadTopRecipeBodies(snapshot, undefined, "charge payment", 3);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.recipe_slug).toBe("charge-succeeded");
  });

  test("respects max parameter", () => {
    const snapshot = makeSnapshot([RECIPE_A, RECIPE_B]);
    const result = loadTopRecipeBodies(snapshot, undefined, "", 1);
    expect(result).toHaveLength(1);
  });

  test("skips recipes missing required fields (no workflow)", () => {
    const bad = { slug: "bad", title: "Missing workflow" };
    const snapshot = makeSnapshot([bad, RECIPE_A]);
    const result = loadTopRecipeBodies(snapshot, undefined, "", 3);
    expect(result.every((r) => r.recipe_slug !== "bad")).toBe(true);
  });

  test("slug asc tiebreak for equal scores", () => {
    const snapshot = makeSnapshot([RECIPE_B, RECIPE_A]);
    const result = loadTopRecipeBodies(snapshot, undefined, "unrelated query", 2);
    expect(result[0]!.recipe_slug).toBe("charge-succeeded");
    expect(result[1]!.recipe_slug).toBe("refund-issued");
  });
});
