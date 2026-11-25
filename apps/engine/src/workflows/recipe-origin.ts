import { recipePackPredicate } from "../connectors/recipe-packs.ts";
import { builtFromRecipe, recipeForOrigin } from "../connectors/solutions.ts";
import { PIN_RULE, pinInstallInputs } from "./recipe-install-inputs.ts";

export type RecipeOriginCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "recipe_unknown" | "recipe_mismatch";
      readonly message: string;
    };

const originRecipe = (origin: { vertical: string; slug: string }) => {
  const predicate = recipePackPredicate(origin.vertical);
  return recipeForOrigin(
    origin,
    predicate ? { categories: predicate.match_categories, tags: predicate.match_tags } : null,
  );
};

export type PinnedRecipeDefinition =
  | { readonly ok: true; readonly definition: unknown }
  | { readonly ok: false; readonly reason: "recipe_input_invalid"; readonly message: string };

export function pinnedRecipeDefinition(
  origin: { vertical: string; slug: string; inputs?: Record<string, unknown> | undefined },
  definition: unknown,
): PinnedRecipeDefinition {
  const recipe = originRecipe(origin);
  if (!recipe || !origin.inputs) return { ok: true, definition };
  const pinned = pinInstallInputs(definition, recipe.install_inputs, origin.inputs);
  return pinned.ok
    ? pinned
    : {
        ok: false,
        reason: "recipe_input_invalid",
        message: `install input ${pinned.key} of recipe ${origin.vertical}/${origin.slug} ${PIN_RULE}`,
      };
}

export function checkRecipeOrigin(
  origin: { vertical: string; slug: string },
  definition: unknown,
): RecipeOriginCheck {
  const recipe = originRecipe(origin);
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
