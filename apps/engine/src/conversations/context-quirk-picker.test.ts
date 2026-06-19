// Per-turn operator-quirk category picker + render contract.
//
// Pinned in unit tests so the token-budget win on `propose_step
// kind=transform` (and the "no auth quirks while transforming"
// invariant) cannot silently regress.

import { describe, expect, test } from "bun:test";
import {
  formatConnectorRecipes,
  formatOperatorQuirks,
  selectOperatorQuirkCategories,
} from "../llm/core/context-assembler.ts";
import type { AuthoringPromptHint } from "../llm/types.ts";

function hint(stage: AuthoringPromptHint["stage"]): AuthoringPromptHint {
  return {
    mode: "AUTHORING",
    stage,
    lifecycle_state: "draft_only",
    active_target: { kind: "workflow", lifecycle_state: "draft_only" },
    blocked_by: [],
    next_required_action: null,
    next_suggested_tool: null,
    checkpoints: [],
    latest_execution: null,
    latest_diagnosis: null,
  } as unknown as AuthoringPromptHint;
}

describe("selectOperatorQuirkCategories", () => {
  test("idle → general only", () => {
    expect(selectOperatorQuirkCategories(hint("idle"), false)).toEqual(["general"]);
  });

  test("workflow_draft_started → auth + pagination + rate_limit + general", () => {
    expect(selectOperatorQuirkCategories(hint("workflow_draft_started"), false)).toEqual([
      "auth",
      "pagination",
      "rate_limit",
      "general",
    ]);
  });

  test("workflow_validated → schema + general (no auth/pagination/rate_limit)", () => {
    const cats = selectOperatorQuirkCategories(hint("workflow_validated"), false);
    expect(cats).not.toContain("auth");
    expect(cats).not.toContain("rate_limit");
    expect(cats).not.toContain("pagination");
    expect(cats).toContain("schema");
  });

  test("connector_probed → auth + general", () => {
    expect(selectOperatorQuirkCategories(hint("connector_probed"), false)).toEqual([
      "auth",
      "general",
    ]);
  });

  test("hasFailures → error_handling + schema + general (overrides stage)", () => {
    expect(selectOperatorQuirkCategories(hint("workflow_draft_started"), true)).toEqual([
      "error_handling",
      "schema",
      "general",
    ]);
  });

  test("undefined hint → general", () => {
    expect(selectOperatorQuirkCategories(undefined, false)).toEqual(["general"]);
  });

  test("diagnosing/repairing → error_handling + schema + general", () => {
    expect(selectOperatorQuirkCategories(hint("diagnosing"), false)).toContain("error_handling");
    expect(selectOperatorQuirkCategories(hint("repairing"), false)).toContain("error_handling");
  });
});

describe("formatOperatorQuirks", () => {
  const QUIRKS = {
    auth: "Bearer key",
    pagination: "cursor via starting_after",
    rate_limit: "100 rps",
    schema: "amounts in cents",
    error_handling: "treat 422 as success on upsert",
    general: "general note",
  };

  test("renders only the requested categories", () => {
    const block = formatOperatorQuirks("stripe", "Stripe", QUIRKS, ["auth", "general"]);
    expect(block).toContain("auth");
    expect(block).toContain("Bearer key");
    expect(block).toContain("general");
    expect(block).not.toContain("cursor via starting_after");
    expect(block).not.toContain("amounts in cents");
  });

  test("returns null when none of the picked categories has content", () => {
    expect(formatOperatorQuirks("stripe", "Stripe", { auth: "x" }, ["schema"])).toBeNull();
  });

  test("includes the connector slug + display name in the header", () => {
    const block = formatOperatorQuirks("stripe", "Stripe Live", QUIRKS, ["general"]);
    expect(block).toContain("`stripe`");
    expect(block).toContain("(Stripe Live)");
  });
});

describe("formatConnectorRecipes", () => {
  test("returns null when snapshot has no recipes", () => {
    expect(formatConnectorRecipes("stripe", { recipes: [] })).toBeNull();
    expect(formatConnectorRecipes("stripe", {})).toBeNull();
  });

  test("renders slug + title + category + tags + difficulty + intent_keywords per recipe", () => {
    const block = formatConnectorRecipes("stripe", {
      recipes: [
        {
          slug: "list-customers",
          title: "List recent Stripe customers",
          category: "payments",
          tags: ["read"],
          difficulty: "intermediate",
          intent_keywords: ["list customers", "recent customers"],
        },
        {
          slug: "create-customer",
          title: "Create a Stripe customer",
          category: "payments",
          tags: [],
          difficulty: "advanced",
          intent_keywords: ["create customer"],
        },
      ],
    });
    expect(block).toContain("`list-customers`");
    expect(block).toContain("List recent Stripe customers");
    expect(block).toContain("category: payments");
    expect(block).toContain("tags: read");
    expect(block).toContain("list customers, recent customers");
    expect(block).toContain("`create-customer`");
    // `intermediate` is the default — drop from output to save tokens.
    expect(block).not.toContain("difficulty: intermediate");
    // Non-default difficulty surfaces.
    expect(block).toContain("difficulty: advanced");
    // The on-demand inspect_recipe path is mentioned so the LLM knows
    // how to fetch the heavier description / sample_input.
    expect(block).toContain("inspect_recipe");
  });

  test("recipe entries without slug or title are skipped", () => {
    const block = formatConnectorRecipes("stripe", {
      recipes: [
        { slug: null, title: "x" },
        { slug: "ok", title: "OK", intent_keywords: [] },
      ],
    });
    expect(block).toContain("`ok`");
    expect(block).not.toContain("null");
  });

  test("truncates to RECIPE_LINES_BUDGET and points to inspect_recipe for the rest", () => {
    const recipes = Array.from({ length: 30 }, (_, i) => ({
      slug: `r-${i}`,
      title: `Recipe ${i}`,
    }));
    const block = formatConnectorRecipes("big", { recipes })!;
    expect(block).toContain("`r-0`");
    expect(block).toContain("`r-23`");
    expect(block).not.toContain("`r-24`");
    expect(block).toContain("… and 6 more");
  });
});
