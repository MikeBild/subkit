import { recipePackPredicate } from "../connectors/recipe-packs.ts";
import { builtFromRecipe, recipeForOrigin } from "../connectors/solutions.ts";

export type RecipeOriginCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "recipe_unknown" | "recipe_mismatch";
      readonly message: string;
    };

export function checkRecipeOrigin(
  origin: { vertical: string; slug: string },
  definition: unknown,
): RecipeOriginCheck {
  const predicate = recipePackPredicate(origin.vertical);
  const recipe = recipeForOrigin(
    origin,
    predicate ? { categories: predicate.match_categories, tags: predicate.match_tags } : null,
  );
  const name = `${origin.vertical}/${origin.slug}`;
  if (!recipe)
    return {
      ok: false,
      reason: "recipe_unknown",
      message: `no recipe ${name} in the recipe packs`,
    };
  if (!builtFromRecipe(definition, recipe))
    return {
      ok: false,
      reason: "recipe_mismatch",
      message: `the definition was not created from recipe ${name}: its steps differ from the recipe's`,
    };
  return { ok: true };
}
