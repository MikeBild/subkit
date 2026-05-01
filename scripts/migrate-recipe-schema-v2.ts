// One-shot migration: backfill the F1 recipe-schema fields onto every
// recipe in `apps/engine/src/connectors/templates.json`.
//
// Per the no-backwards-compat memory rule (subkit isn't in production),
// this runs once, rewrites the file in place, and is then archival —
// future recipes are authored with the full shape from day 1.
//
// Backfill rules:
//   - category: derived from the parent template's category, mapped
//     into the RecipeCategoryEnum. AWS / cloud / GCP templates collapse
//     onto the more meaningful work-domain category when obvious
//     (DynamoDB → database, SQS → messaging-via-other, etc.); fallback
//     keeps the connector category verbatim when it already lives in
//     the enum.
//   - tags: empty (operator refines later; lint allows empty).
//   - difficulty: "intermediate" (the historical median for the 190
//     existing recipes).
//   - estimated_setup_minutes: 5.
//   - prerequisites: empty.
//   - sample_input: null.
//   - expected_output_preview: null.
//   - required_connectors: empty (every recipe today is single-connector).
//   - version: "1.0.0".
//   - author: "subkit-builtin".
//   - last_validated_at: null (no field-validated recipes pre-migration).
//   - deprecated: null.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATES_PATH = resolve(import.meta.dir, "..", "apps/engine/src/connectors/templates.json");

const CATEGORY_ENUM = new Set([
  "ai",
  "analytics",
  "aws",
  "cloud",
  "communication",
  "crm",
  "database",
  "devops",
  "ecommerce",
  "enterprise",
  "marketing",
  "payments",
  "productivity",
  "project-management",
  "protocol",
  "scraping",
  "storage",
  "support",
  "other",
]);

// Per-template category override when the connector category is too
// generic (most AWS templates carry `aws` or `cloud` but the recipe
// lives in a more specific work-domain).
const TEMPLATE_CATEGORY_OVERRIDES: Record<string, string> = {
  "aws-dynamodb": "database",
  "aws-s3": "storage",
  "aws-sqs": "communication",
  "aws-ses": "communication",
  "aws-lambda": "devops",
  "aws-cognito-user-pools": "enterprise",
  "aws-apigw-iam": "devops",
  "appsync-iam": "database",
  "appsync-cognito": "database",
  "azure-blob-storage": "storage",
  "google-cloud-storage": "storage",
};

type Recipe = Record<string, unknown>;
type Template = {
  slug: string;
  category: string;
  recipes?: Recipe[];
  [k: string]: unknown;
};

function inferCategory(template: Template): string {
  const override = TEMPLATE_CATEGORY_OVERRIDES[template.slug];
  if (override) return override;
  if (CATEGORY_ENUM.has(template.category)) return template.category;
  return "other";
}

function migrateRecipe(recipe: Recipe, category: string): Recipe {
  // Idempotent: skip recipes already migrated.
  if (typeof recipe.version === "string" && recipe.author) return recipe;
  return {
    slug: recipe.slug,
    title: recipe.title,
    description: recipe.description,
    intent_keywords: recipe.intent_keywords ?? [],
    derived_from_skill: recipe.derived_from_skill ?? null,
    category,
    tags: [],
    difficulty: "intermediate",
    estimated_setup_minutes: 5,
    prerequisites: [],
    sample_input: null,
    expected_output_preview: null,
    required_connectors: [],
    version: "1.0.0",
    author: "subkit-builtin",
    last_validated_at: null,
    deprecated: null,
    workflow: recipe.workflow,
  };
}

function main() {
  const raw = readFileSync(TEMPLATES_PATH, "utf8");
  const templates = JSON.parse(raw) as Template[];
  let recipeCount = 0;
  let migratedCount = 0;
  for (const t of templates) {
    if (!t.recipes || t.recipes.length === 0) continue;
    const category = inferCategory(t);
    const next: Recipe[] = [];
    for (const r of t.recipes) {
      recipeCount += 1;
      const before = r;
      const after = migrateRecipe(r, category);
      if (after !== before) migratedCount += 1;
      next.push(after);
    }
    t.recipes = next;
  }
  writeFileSync(TEMPLATES_PATH, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
  console.log(
    `migrated ${migratedCount}/${recipeCount} recipes across ${templates.length} templates`,
  );
}

main();
