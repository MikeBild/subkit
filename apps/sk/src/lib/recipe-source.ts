import type { components } from "@cli-core/engine-api/openapi.d.ts";

export type RecipePackEntry = components["schemas"]["RecipePackEntry"];

export const SOLUTIONS_VERTICAL = "solutions";

export interface WorkflowSource {
  body: Record<string, unknown>;
  previewInput: unknown;
  recipe: { vertical: string; slug: string } | null;
}

export interface KnownConnector {
  id: string;
  slug: string;
}

export function parseBinds(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  const binds: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [key, value, ...rest] = pair.split("=").map((part) => part.trim());
    if (!key || !value || rest.length > 0) {
      throw new Error(`--bind expects <template or placeholder>=<connector>, got "${pair.trim()}"`);
    }
    binds[key] = value;
  }
  return binds;
}

function swapConnectorIds(value: unknown, mapping: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => swapConnectorIds(item, mapping));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      key === "connector_id" && typeof inner === "string" && inner in mapping
        ? mapping[inner]
        : swapConnectorIds(inner, mapping),
    ]),
  );
}

export function recipeWorkflowSource(
  pack: { recipes: ReadonlyArray<Record<string, unknown>> },
  slug: string,
  binds: Record<string, string> = {},
  connectors: readonly KnownConnector[] = [],
): WorkflowSource {
  const entries = pack.recipes as ReadonlyArray<RecipePackEntry>;
  const entry = entries.find((candidate) => candidate.recipe_slug === slug);
  if (!entry) {
    const known = entries.map((candidate) => candidate.recipe_slug).join(", ");
    throw new Error(`no solution recipe "${slug}"; available: ${known || "none"}`);
  }
  const mapping: Record<string, string> = {};
  const missing: string[] = [];
  for (const binding of entry.connectors) {
    const wanted = binds[binding.placeholder] ?? binds[binding.template];
    const current = binding.connector_id ?? binding.placeholder;
    if (wanted) {
      const target = connectors.find((c) => c.id === wanted || c.slug === wanted);
      if (!target) throw new Error(`--bind names no connector "${wanted}"`);
      mapping[current] = target.id;
    } else if (binding.connector_id === null) {
      missing.push(
        `${binding.template_name} (--bind ${binding.template}=<connector id or slug>, or sk connectors create --template ${binding.template})`,
      );
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `solution "${slug}" needs a connector for ${missing.join(", ")}; then run this again`,
    );
  }
  return {
    body: swapConnectorIds(entry.workflow, mapping) as Record<string, unknown>,
    previewInput: entry.sample_input ?? null,
    recipe: { vertical: SOLUTIONS_VERTICAL, slug },
  };
}

export function createBodyFor(source: WorkflowSource): Record<string, unknown> {
  return source.recipe ? { ...source.body, recipe: source.recipe } : source.body;
}
