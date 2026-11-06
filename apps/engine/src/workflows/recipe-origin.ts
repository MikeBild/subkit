import { builtFromRecipe, recipeForOrigin } from "../connectors/solutions.ts";

export interface RecipePackPredicate {
  readonly match_categories: readonly string[];
  readonly match_tags: readonly string[];
}

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
  packs: Readonly<Record<string, RecipePackPredicate>>,
): RecipeOriginCheck {
  const predicate = Object.hasOwn(packs, origin.vertical) ? packs[origin.vertical] : undefined;
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
