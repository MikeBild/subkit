import { describe, expect, test } from "bun:test";
import { recipePackPredicate } from "../../../connectors/recipe-packs.ts";
import { loadBuiltinTemplates } from "../../../connectors/templates.ts";
import { checkRecipeOrigin } from "../../../workflows/recipe-origin.ts";

function builtinRecipe(templateSlug: string, recipeSlug: string) {
  const template = loadBuiltinTemplates().find((candidate) => candidate.slug === templateSlug);
  const recipe = template?.recipes.find((candidate) => candidate.slug === recipeSlug);
  if (!recipe) throw new Error(`builtin recipe ${templateSlug}/${recipeSlug} is missing`);
  return recipe;
}

describe("recipe origin check through a vertical predicate", () => {
  test("a devops recipe built from its steps passes the devops pack", () => {
    const recipe = builtinRecipe("github", "list-my-repos");
    expect(recipe.category).toBe("devops");
    expect(checkRecipeOrigin({ vertical: "devops", slug: recipe.slug }, recipe.workflow)).toEqual({
      ok: true,
    });
  });

  test("the same devops recipe with other steps is a mismatch", () => {
    expect(
      checkRecipeOrigin(
        { vertical: "devops", slug: "list-my-repos" },
        { steps: [{ id: "something-else" }] },
      ),
    ).toEqual({
      ok: false,
      reason: "recipe_mismatch",
      message:
        "the definition was not created from recipe devops/list-my-repos: its steps differ from the recipe's",
    });
  });

  test("a builtin recipe outside the vertical's categories and tags is unknown to that pack", () => {
    const recipe = builtinRecipe("stripe", "get-customer");
    const devops = recipePackPredicate("devops");
    expect(devops?.match_categories).not.toContain(recipe.category);
    expect(recipe.tags.some((tag) => devops?.match_tags.includes(tag))).toBe(false);
    expect(checkRecipeOrigin({ vertical: "devops", slug: recipe.slug }, recipe.workflow)).toEqual({
      ok: false,
      reason: "recipe_unknown",
      message: "no recipe devops/get-customer in the recipe packs",
    });
    expect(checkRecipeOrigin({ vertical: "finance", slug: recipe.slug }, recipe.workflow)).toEqual({
      ok: true,
    });
  });

  test("only the predicate verticals have a predicate", () => {
    expect(recipePackPredicate("devops")?.match_categories).toEqual(["devops", "analytics"]);
    expect(recipePackPredicate("solutions")).toBeNull();
    expect(recipePackPredicate("toString")).toBeNull();
    expect(recipePackPredicate("made-up")).toBeNull();
  });
});
