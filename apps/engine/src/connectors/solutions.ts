import { z } from "@hono/zod-openapi";
import solutionsJson from "./solutions.json" with { type: "json" };
import { type ConnectorRecipe, ConnectorRecipeSchema, loadBuiltinTemplates } from "./templates.ts";

export const SOLUTIONS_VERTICAL = "solutions";

export const SOLUTIONS_OUTCOME =
  "Start from a finished flow across several connectors: each solution names the connectors it needs, previews against a sample input and lands as a draft you approve before it runs.";

let cached: ConnectorRecipe[] | null = null;

export function loadSolutionRecipes(): ConnectorRecipe[] {
  if (cached) return cached;
  const parsed = z.array(ConnectorRecipeSchema).safeParse(solutionsJson);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`solutions.json validation failed: ${issues}`);
  }
  const templates = new Set(loadBuiltinTemplates().map((t) => t.slug));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const recipe of parsed.data) {
    if (seen.has(recipe.slug)) problems.push(`${recipe.slug}: duplicate slug`);
    seen.add(recipe.slug);
    if (recipe.required_connectors.length === 0) {
      problems.push(`${recipe.slug}: declares no required_connectors`);
    }
    for (const required of recipe.required_connectors) {
      if (!templates.has(required.template)) {
        problems.push(`${recipe.slug}: unknown template ${required.template}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`solutions.json is inconsistent: ${problems.join("; ")}`);
  }
  cached = Object.freeze([...parsed.data]) as ConnectorRecipe[];
  return cached;
}

export function getSolutionRecipe(slug: string): ConnectorRecipe | null {
  return loadSolutionRecipes().find((recipe) => recipe.slug === slug) ?? null;
}

export function getTemplateRecipe(template: string, slug: string): ConnectorRecipe | null {
  return (
    loadBuiltinTemplates()
      .find((candidate) => candidate.slug === template)
      ?.recipes.find((recipe) => recipe.slug === slug) ?? null
  );
}

interface RecipePackMembership {
  categories: readonly string[];
  tags: readonly string[];
}

export function recipeForOrigin(
  origin: { vertical: string; slug: string },
  pack: RecipePackMembership | null,
): ConnectorRecipe | null {
  if (origin.vertical === SOLUTIONS_VERTICAL) return getSolutionRecipe(origin.slug);
  if (!pack) return null;
  for (const template of loadBuiltinTemplates()) {
    for (const recipe of template.recipes) {
      if (recipe.slug !== origin.slug) continue;
      const inPack =
        pack.categories.includes(recipe.category) ||
        recipe.tags.some((tag) => pack.tags.includes(tag));
      if (inPack) return recipe;
    }
  }
  return null;
}

function stepIds(definition: unknown): string[] {
  const steps = (definition as { steps?: unknown } | null)?.steps;
  return Array.isArray(steps)
    ? steps.map((step) => String((step as { id?: unknown } | null)?.id ?? ""))
    : [];
}

export function builtFromRecipe(definition: unknown, recipe: ConnectorRecipe): boolean {
  const submitted = stepIds(definition);
  const expected = stepIds(recipe.workflow);
  return (
    submitted.length === expected.length && submitted.every((id, index) => id === expected[index])
  );
}
