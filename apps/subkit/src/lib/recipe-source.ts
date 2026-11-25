import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { mailboxInstallInputs, pinInstallInputs } from "@shared/recipe-install-inputs.ts";

export type RecipePackEntry = components["schemas"]["RecipePackEntry"];
export type TemplateRecipe = components["schemas"]["ConnectorTemplateRecipeOutput"];
type RecipeOrigin = { vertical: string; slug: string } | { template: string; slug: string };

export const SOLUTIONS_VERTICAL = "solutions";

export interface WorkflowSource {
  body: Record<string, unknown>;
  previewInput: unknown;
  installInputs?: readonly string[];
  recipe: RecipeOrigin | null;
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
    installInputs: entry.install_inputs ?? [],
    recipe: { vertical: SOLUTIONS_VERTICAL, slug },
  };
}

export function templateRecipeRef(raw: string): { template: string; recipe: string } | null {
  if (!raw.includes("/")) return null;
  const [template, recipe, ...rest] = raw.split("/").map((part) => part.trim());
  if (!template || !recipe || rest.length > 0)
    throw new Error(`--from-recipe expects <solution> or <template>/<recipe>, got "${raw}"`);
  return { template, recipe };
}

export function templateRecipeWorkflowSource(
  templateSlug: string,
  recipe: TemplateRecipe,
  binds: Record<string, string> = {},
  connectors: readonly KnownConnector[] = [],
): WorkflowSource {
  const name = `${templateSlug}/${recipe.slug}`;
  const required = recipe.required_connectors ?? [];
  const known = new Set(required.flatMap((r) => [r.placeholder, r.template]));
  const unknown = Object.keys(binds).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `--bind names ${unknown.map((key) => `"${key}"`).join(", ")}, which recipe "${name}" does not use; it needs: ${[...new Set(required.map((r) => r.template))].join(", ") || "no connector"}`,
    );
  }
  const mapping: Record<string, string> = {};
  const missing: string[] = [];
  for (const binding of required) {
    const wanted = binds[binding.placeholder] ?? binds[binding.template];
    const pick = `--bind ${binding.template}=<connector id or slug>`;
    if (wanted) {
      const target = connectors.find((c) => c.id === wanted || c.slug === wanted);
      if (!target) throw new Error(`--bind names no connector "${wanted}"`);
      if (target.template_slug !== binding.template)
        throw new Error(
          `--bind ${binding.template}=${wanted}: that connector is ${target.template_slug ? `a ${target.template_slug} connector` : "not made from a template"}, not ${binding.template}`,
        );
      mapping[binding.placeholder] = target.id;
      continue;
    }
    const candidates = connectors.filter((c) => c.template_slug === binding.template);
    const [only] = candidates;
    if (candidates.length === 1 && only) mapping[binding.placeholder] = only.id;
    else
      missing.push(
        candidates.length > 1
          ? `${binding.template}: choose one of ${candidates.map((c) => c.slug).join(", ")} with ${pick}`
          : `${binding.template}: ${pick}, or subkit connectors create --template ${binding.template}`,
      );
  }
  if (missing.length > 0)
    throw new Error(
      `recipe "${name}" needs a connector — ${missing.join("; ")}; then run this again`,
    );
  return {
    body: swapConnectorIds(recipe.workflow, mapping) as Record<string, unknown>,
    previewInput: recipe.sample_input,
    installInputs: recipe.install_inputs ?? [],
    recipe: { template: templateSlug, slug: recipe.slug },
  };
}

const isInputObject = (input: unknown): input is Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

const missingInputsMessage = (slug: string, keys: readonly string[]) =>
  `solution "${slug}" needs install input ${keys.map((key) => `"${key}"`).join(", ")}, the address of the sending mailbox; add --input '${JSON.stringify(Object.fromEntries(keys.map((key) => [key, "<mailbox address>"])))}' and run this again`;

const originName = (origin: RecipeOrigin): string =>
  `${"template" in origin ? origin.template : origin.vertical}/${origin.slug}`;

const blankInput = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && !value.trim()) ||
  (Array.isArray(value) && value.length === 0);

function missingInstallInputsMessage(source: WorkflowSource, missing: readonly string[]): string {
  const properties = (
    source.body as { input_schema?: { properties?: Record<string, Record<string, unknown>> } }
  ).input_schema?.properties;
  const described = missing.map((key) => {
    const description = properties?.[key]?.description;
    return typeof description === "string" && description ? `${key} (${description})` : key;
  });
  const example = Object.fromEntries(
    missing.map((key) => [
      key,
      properties?.[key]?.type === "array" ? ["docs.example.com"] : "<value>",
    ]),
  );
  const plural = missing.length > 1;
  return `recipe ${source.recipe ? originName(source.recipe) : ""} needs install input${plural ? "s" : ""} ${described.join(", ")}; pass ${plural ? "them" : "it"} with --input '${JSON.stringify(example)}'`;
}

export function createBodyFor(source: WorkflowSource, input?: unknown): Record<string, unknown> {
  if (!source.recipe) return source.body;
  const declared = source.installInputs ?? [];
  const recipe = isInputObject(input) ? { ...source.recipe, inputs: input } : source.recipe;
  const given = isInputObject(input) ? input : {};
  const missingSenders = mailboxInstallInputs(source.body, declared).filter(
    (key) => !Object.hasOwn(given, key),
  );
  if (missingSenders.length > 0)
    throw new Error(missingInputsMessage(source.recipe.slug, missingSenders));
  const missing = declared.filter((key) => blankInput(given[key]));
  if (missing.length > 0) throw new Error(missingInstallInputsMessage(source, missing));
  const pinned = pinInstallInputs(source.body, declared, given);
  if (!pinned.ok) throw new Error(`recipe ${originName(source.recipe)}: ${pinned.message}`);
  return { ...(pinned.definition as Record<string, unknown>), recipe };
}
