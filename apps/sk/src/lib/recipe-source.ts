import type { components } from "@cli-core/engine-api/openapi.d.ts";

export type RecipePackEntry = components["schemas"]["RecipePackEntry"];

export const SOLUTIONS_VERTICAL = "solutions";

export interface WorkflowSource {
  body: Record<string, unknown>;
  previewInput: unknown;
  recipe: { vertical: string; slug: string } | null;
}

export function recipeWorkflowSource(
  pack: { recipes: ReadonlyArray<Record<string, unknown>> },
  slug: string,
): WorkflowSource {
  const entries = pack.recipes as ReadonlyArray<RecipePackEntry>;
  const entry = entries.find((candidate) => candidate.recipe_slug === slug);
  if (!entry) {
    const known = entries.map((candidate) => candidate.recipe_slug).join(", ");
    throw new Error(`no solution recipe "${slug}"; available: ${known || "none"}`);
  }
  const missing = entry.connectors.filter((connector) => connector.connector_id === null);
  if (missing.length > 0) {
    const needed = missing
      .map(
        (connector) =>
          `${connector.template_name} (sk connectors create --template ${connector.template})`,
      )
      .join(", ");
    throw new Error(
      `solution "${slug}" needs a connector for ${needed}; sign it in, then run this again`,
    );
  }
  return {
    body: entry.workflow,
    previewInput: entry.sample_input ?? null,
    recipe: { vertical: SOLUTIONS_VERTICAL, slug },
  };
}

export function createBodyFor(source: WorkflowSource): Record<string, unknown> {
  return source.recipe ? { ...source.body, recipe: source.recipe } : source.body;
}
