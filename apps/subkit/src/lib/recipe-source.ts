import type { components } from "@cli-core/engine-api/openapi.d.ts";

export type RecipePackEntry = components["schemas"]["RecipePackEntry"];

export const SOLUTIONS_VERTICAL = "solutions";

export interface WorkflowSource {
  body: Record<string, unknown>;
  previewInput: unknown;
  recipe: { vertical: string; slug: string } | null;
}

interface KnownConnector {
  id: string;
  slug: string;
  template_slug: string | null;
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
  const keys = new Set(entry.connectors.flatMap((c) => [c.placeholder, c.template]));
  const unknown = Object.keys(binds).filter((key) => !keys.has(key));
  if (unknown.length > 0) {
    const valid = [...new Set(entry.connectors.map((c) => c.template))].join(", ");
    throw new Error(
      `--bind names ${unknown.map((key) => `"${key}"`).join(", ")}, which solution "${slug}" does not use; it needs: ${valid}`,
    );
  }
  const mapping: Record<string, string> = {};
  const missing: string[] = [];
  for (const binding of entry.connectors) {
    const wanted = binds[binding.placeholder] ?? binds[binding.template];
    const current = binding.connector_id ?? binding.placeholder;
    if (wanted) {
      const target = connectors.find((c) => c.id === wanted || c.slug === wanted);
      if (!target) throw new Error(`--bind names no connector "${wanted}"`);
      if (target.template_slug !== binding.template) {
        throw new Error(
          `--bind ${binding.template}=${wanted}: that connector is ${target.template_slug ? `a ${target.template_slug} connector` : "not made from a template"}, not ${binding.template_name}`,
        );
      }
      mapping[current] = target.id;
    } else if (binding.connector_id === null) {
      const pick = `--bind ${binding.template}=<connector id or slug>`;
      missing.push(
        binding.candidates.length > 0
          ? `${binding.template_name}: choose one of ${binding.candidates.map((c) => c.slug).join(", ")} with ${pick}`
          : `${binding.template_name}: ${pick}, or subkit connectors create --template ${binding.template}`,
      );
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `solution "${slug}" needs a connector — ${missing.join("; ")}; then run this again`,
    );
  }
  return {
    body: swapConnectorIds(entry.workflow, mapping) as Record<string, unknown>,
    previewInput: entry.sample_input,
    recipe: { vertical: SOLUTIONS_VERTICAL, slug },
  };
}

const isInputObject = (input: unknown): input is Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

export function createBodyFor(source: WorkflowSource, input?: unknown): Record<string, unknown> {
  if (!source.recipe) return source.body;
  const recipe = isInputObject(input) ? { ...source.recipe, inputs: input } : source.recipe;
  return { ...source.body, recipe };
}
