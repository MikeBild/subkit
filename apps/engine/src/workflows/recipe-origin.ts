import { randomUUID } from "node:crypto";
import { recipePackPredicate } from "../connectors/recipe-packs.ts";
import { builtFromRecipe, recipeForOrigin } from "../connectors/solutions.ts";
import { pinInstallInputs } from "./recipe-install-inputs.ts";

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
  | {
      readonly ok: false;
      readonly reason: "recipe_input_invalid" | "recipe_input_missing";
      readonly message: string;
    };

export function pinnedRecipeDefinition(
  origin: { vertical: string; slug: string; inputs?: Record<string, unknown> | undefined },
  definition: unknown,
): PinnedRecipeDefinition {
  const recipe = originRecipe(origin);
  if (!recipe) return { ok: true, definition };
  const pinned = pinInstallInputs(definition, recipe.install_inputs, origin.inputs ?? {});
  if (pinned.ok) return pinned;
  const name = `install input ${pinned.key} of recipe ${origin.vertical}/${origin.slug}`;
  return pinned.missing
    ? {
        ok: false,
        reason: "recipe_input_missing",
        message: `${name} is required: it ${pinned.rule}`,
      }
    : { ok: false, reason: "recipe_input_invalid", message: `${name} ${pinned.rule}` };
}

type DeliveryStep = { kind: "request"; transactional_delivery: Record<string, unknown> };

const isDelivery = (step: unknown): step is DeliveryStep =>
  (step as { kind?: unknown } | null)?.kind === "request" &&
  typeof (step as { transactional_delivery?: unknown }).transactional_delivery === "object" &&
  (step as { transactional_delivery?: unknown }).transactional_delivery !== null;

export function recipeDeliveryBinding<T>(
  definition: T,
): { readonly definition: T; readonly binding_id: string } | null {
  const shape = definition as { trigger?: { kind?: unknown }; steps?: unknown };
  if (shape.trigger?.kind !== "webhook" || !Array.isArray(shape.steps)) return null;
  if (!shape.steps.some(isDelivery)) return null;
  const binding_id = randomUUID();
  const steps = shape.steps.map((step: unknown) =>
    isDelivery(step)
      ? {
          ...step,
          transactional_delivery: { ...step.transactional_delivery, webhook_id: binding_id },
        }
      : step,
  );
  return { definition: { ...shape, steps } as T, binding_id };
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
