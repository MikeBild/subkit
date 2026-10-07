import { builtFromRecipe, recipeForOrigin } from "../../connectors/index.ts";
import { UnprocessableEntityError } from "../errors.ts";
import {
  type PredicateRecipePackVertical,
  RECIPE_PACK_PREDICATES,
} from "./connector-templates/schemas.ts";

export function assertRecipeOrigin(
  origin: { vertical: string; slug: string },
  definition: unknown,
): void {
  const predicate = Object.hasOwn(RECIPE_PACK_PREDICATES, origin.vertical)
    ? RECIPE_PACK_PREDICATES[origin.vertical as PredicateRecipePackVertical]
    : null;
  const recipe = recipeForOrigin(
    origin,
    predicate ? { categories: predicate.match_categories, tags: predicate.match_tags } : null,
  );
  const name = `${origin.vertical}/${origin.slug}`;
  if (!recipe) {
    throw new UnprocessableEntityError(`no recipe ${name} in the recipe packs`, {
      reason: "recipe_unknown",
    });
  }
  if (!builtFromRecipe(definition, recipe)) {
    throw new UnprocessableEntityError(
      `the definition was not created from recipe ${name}: its steps differ from the recipe's`,
      { reason: "recipe_mismatch" },
    );
  }
}
