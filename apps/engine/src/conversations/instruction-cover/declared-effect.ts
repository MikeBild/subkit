import { loadBuiltinTemplates } from "../../connectors/templates.ts";
import type { EffectClass } from "./bound-action.ts";
import { NEVER_TOKENS } from "./effect-vocabulary.ts";

interface DeclaredOperation {
  readonly method: string;
  readonly path: RegExp;
  readonly effect: EffectClass;
}

interface DeclaredTemplate {
  readonly fallback: EffectClass | null;
  readonly operations: readonly DeclaredOperation[];
}

const CATEGORY_EFFECT: Readonly<Record<string, EffectClass>> = {
  payments: "payment",
  marketing: "publication",
};

let index: Map<string, DeclaredTemplate> | null = null;

function words(raw: string): string[] {
  return raw
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length > 0);
}

function namedEffect(tokens: readonly string[]): EffectClass {
  for (const [effect, vocabulary] of NEVER_TOKENS) {
    if (tokens.some((token) => vocabulary.has(token))) return effect;
  }
  return "ordinary";
}

function pathPattern(url: string): RegExp | null {
  const withoutBase = url.replace(/^\$\{connector\.[^}]+\.base_url\}/u, "");
  if (withoutBase === url || /^\$\{/u.test(withoutBase)) return null;
  const route = withoutBase.split("?", 1)[0] ?? "";
  const source = route
    .split(/(\$\{[^}]+\})/u)
    .map((part) => (part.startsWith("${") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
    .join("");
  return new RegExp(`^${source.length > 0 ? source : "/?"}/?$`, "u");
}

function steps(value: unknown, into: Array<Record<string, unknown>>, depth = 0): void {
  if (depth > 12 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) steps(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.method === "string" &&
    (typeof record.url === "string" || typeof record.path === "string")
  )
    into.push(record);
  for (const nested of Object.values(record)) steps(nested, into, depth + 1);
}

function templateUrl(
  step: Record<string, unknown>,
  slug: string,
  owned: ReadonlySet<string>,
): string | null {
  const base = `\${connector.${slug}.base_url}`;
  if (typeof step.url === "string") return step.url.startsWith(base) ? step.url : null;
  if (typeof step.path !== "string" || typeof step.connector_id !== "string") return null;
  return owned.has(step.connector_id) ? `${base}${step.path}` : null;
}

function build(): Map<string, DeclaredTemplate> {
  const out = new Map<string, DeclaredTemplate>();
  for (const template of loadBuiltinTemplates()) {
    const operations: DeclaredOperation[] = [];
    for (const recipe of template.recipes ?? []) {
      const effect = namedEffect([
        ...words(recipe.slug),
        ...words(recipe.title),
        ...recipe.tags.flatMap(words),
      ]);
      const owned = new Set(
        recipe.required_connectors
          .filter((required) => required.template === template.slug)
          .map((required) => required.placeholder),
      );
      const found: Array<Record<string, unknown>> = [];
      steps(recipe.workflow, found);
      for (const step of found) {
        const method = String(step.method).toUpperCase();
        if (method === "GET" || step.side_effects === "read") continue;
        const url = templateUrl(step, template.slug, owned);
        if (!url) continue;
        const path = pathPattern(url);
        if (path) operations.push({ method, path, effect });
      }
    }
    out.set(template.slug, {
      fallback: CATEGORY_EFFECT[template.category ?? ""] ?? null,
      operations,
    });
  }
  return out;
}

export function declaredEffect(
  template: string | null,
  method: string,
  path: string,
): EffectClass | null {
  if (!template) return null;
  index ??= build();
  const declared = index.get(template);
  if (!declared) return null;
  const route = path.startsWith("/") ? path : `/${path}`;
  const matching = new Set(
    declared.operations
      .filter((operation) => operation.method === method && operation.path.test(route))
      .map((operation) => operation.effect),
  );
  if (matching.size === 1) return [...matching][0] ?? null;
  if (matching.size > 1) return "unknown";
  return declared.fallback;
}

export function declaredOperations(template: string): readonly DeclaredOperation[] {
  index ??= build();
  return index.get(template)?.operations ?? [];
}
