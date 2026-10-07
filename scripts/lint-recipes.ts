import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATES_PATH = resolve(import.meta.dir, "..", "apps/engine/src/connectors/templates.json");
const SOLUTIONS_PATH = resolve(import.meta.dir, "..", "apps/engine/src/connectors/solutions.json");
const SOLUTIONS = "<solutions>";

type Recipe = {
  slug: string;
  title: string;
  intent_keywords?: string[];
  category?: string;
  sample_input?: unknown;
  expected_output_preview?: unknown;
  required_connectors?: Array<{ placeholder: string; template: string }>;
  workflow: {
    name?: string;
    input_schema?: Record<string, unknown>;
    steps?: Array<Record<string, unknown>>;
    trigger?: { kind?: string; [k: string]: unknown };
    max_llm_tokens_per_run?: number;
  };
};

type Template = {
  slug: string;
  recipes?: Recipe[];
};

const RECIPE_CATEGORY_ENUM = new Set([
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

const STEP_KINDS = ["request", "transform", "call", "wait", "branch", "parallel", "loop"] as const;

const WORKFLOW_FEATURE_KINDS = ["webhook", "schedule", "budgeted-llm"] as const;

type Violation = { template: string; recipe: string; rule: string; message: string };

function lintIntentKeywords(template: string, recipe: Recipe): Violation[] {
  const out: Violation[] = [];
  const kw = recipe.intent_keywords ?? [];
  if (kw.length < 3 || kw.length > 7) {
    out.push({
      template,
      recipe: recipe.slug,
      rule: "intent_keywords_count",
      message: `intent_keywords must have 3-7 entries; has ${kw.length}`,
    });
  }
  for (const k of kw) {
    if (k !== k.toLowerCase()) {
      out.push({
        template,
        recipe: recipe.slug,
        rule: "intent_keywords_lowercase",
        message: `intent keyword \`${k}\` must be lowercase`,
      });
    }
  }
  const seen = new Set<string>();
  for (const k of kw) {
    if (seen.has(k)) {
      out.push({
        template,
        recipe: recipe.slug,
        rule: "intent_keywords_unique",
        message: `intent keyword \`${k}\` is duplicated`,
      });
    }
    seen.add(k);
  }
  const titleWords = new Set(
    recipe.title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
  for (const k of kw) {
    if (!k.includes(" ") && titleWords.has(k)) {
      out.push({
        template,
        recipe: recipe.slug,
        rule: "intent_keywords_title_overlap",
        message: `single-word keyword \`${k}\` is already in the title; remove or replace with a phrase`,
      });
    }
  }
  return out;
}

function lintCategory(template: string, recipe: Recipe): Violation[] {
  if (!recipe.category) {
    return [
      {
        template,
        recipe: recipe.slug,
        rule: "category_missing",
        message: "category is required",
      },
    ];
  }
  if (!RECIPE_CATEGORY_ENUM.has(recipe.category)) {
    return [
      {
        template,
        recipe: recipe.slug,
        rule: "category_invalid",
        message: `category \`${recipe.category}\` is not a member of RecipeCategoryEnum`,
      },
    ];
  }
  return [];
}

function lintSampleInputAlignment(template: string, recipe: Recipe): Violation[] {
  const sample = recipe.sample_input;
  const schema = recipe.workflow.input_schema;
  if (sample == null && schema == null) return [];
  if (
    sample != null &&
    schema != null &&
    typeof schema === "object" &&
    Array.isArray((schema as { required?: unknown }).required)
  ) {
    const required = (schema as { required: string[] }).required;
    if (typeof sample !== "object" || sample === null) {
      return [
        {
          template,
          recipe: recipe.slug,
          rule: "sample_input_shape",
          message: "sample_input must be an object when input_schema declares required props",
        },
      ];
    }
    const sampleObj = sample as Record<string, unknown>;
    const missing = required.filter((k) => !(k in sampleObj));
    if (missing.length > 0) {
      return [
        {
          template,
          recipe: recipe.slug,
          rule: "sample_input_missing_required",
          message: `sample_input missing required input_schema keys: ${missing.join(", ")}`,
        },
      ];
    }
  }
  return [];
}

function lintRequiredConnectors(template: string, recipe: Recipe): Violation[] {
  const required = recipe.required_connectors ?? [];
  if (required.length === 0) return [];
  const seenPlaceholders = new Set<string>();
  for (const step of recipe.workflow.steps ?? []) {
    const cid = (step as { connector_id?: unknown }).connector_id;
    if (typeof cid === "string") seenPlaceholders.add(cid);
  }
  const out: Violation[] = [];
  for (const req of required) {
    if (!seenPlaceholders.has(req.placeholder)) {
      out.push({
        template,
        recipe: recipe.slug,
        rule: "required_connectors_unused_placeholder",
        message: `placeholder \`${req.placeholder}\` (template \`${req.template}\`) does not appear in any workflow.steps[*].connector_id`,
      });
    }
  }
  return out;
}

function lintSolution(recipe: Recipe, templateSlugs: ReadonlySet<string>): Violation[] {
  const out: Violation[] = [];
  const violation = (rule: string, message: string) =>
    out.push({ template: SOLUTIONS, recipe: recipe.slug, rule, message });
  if (recipe.sample_input == null) violation("solution_sample_input", "sample_input is required");
  if (recipe.expected_output_preview == null) {
    violation("solution_expected_output", "expected_output_preview is required");
  }
  const required = recipe.required_connectors ?? [];
  if (required.length === 0) {
    violation("solution_required_connectors", "a solution declares its required_connectors");
  }
  for (const req of required) {
    if (!templateSlugs.has(req.template)) {
      violation(
        "solution_unknown_template",
        `template \`${req.template}\` is not in templates.json`,
      );
    }
  }
  return out;
}

function buildPrimitiveCoverage(templates: Template[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries([
    ...STEP_KINDS.map((k) => [k, 0] as const),
    ...WORKFLOW_FEATURE_KINDS.map((k) => [k, 0] as const),
  ]);
  for (const t of templates) {
    for (const r of t.recipes ?? []) {
      for (const step of r.workflow.steps ?? []) {
        const kind = (step as { kind?: unknown }).kind;
        if (typeof kind === "string" && kind in counts) counts[kind] += 1;
      }
      const trigger = r.workflow.trigger;
      const triggerKind =
        typeof trigger === "object" && trigger != null && typeof trigger.kind === "string"
          ? trigger.kind
          : undefined;
      if (triggerKind === "webhook") counts.webhook = (counts.webhook ?? 0) + 1;
      if (triggerKind === "schedule") counts.schedule = (counts.schedule ?? 0) + 1;
      const budget = r.workflow.max_llm_tokens_per_run;
      if (typeof budget === "number" && budget > 0) {
        counts["budgeted-llm"] = (counts["budgeted-llm"] ?? 0) + 1;
      }
    }
  }
  return counts;
}

function lintPrimitiveCoverage(templates: Template[]): Violation[] {
  const counts = buildPrimitiveCoverage(templates);
  const out: Violation[] = [];
  const baseline: Record<string, number> = {
    request: 1,
    transform: 1,
    branch: 1,
    parallel: 1,
    wait: 1,
    loop: 1,
    call: 0,
    webhook: 1,
    schedule: 1,
    "budgeted-llm": 1,
  };
  const trackedKinds = [...STEP_KINDS, ...WORKFLOW_FEATURE_KINDS] as readonly string[];
  for (const kind of trackedKinds) {
    const have = counts[kind] ?? 0;
    const need = baseline[kind] ?? 0;
    if (have < need) {
      out.push({
        template: "<catalog>",
        recipe: "<aggregate>",
        rule: "primitive_coverage_regressed",
        message: `primitive \`${kind}\` had ≥${need} recipe(s) at last sweep but now has ${have}`,
      });
    }
  }
  console.log("recipe primitive coverage:");
  for (const kind of trackedKinds) {
    console.log(`  ${kind.padEnd(14)} ${counts[kind] ?? 0}`);
  }
  return out;
}

function main() {
  const raw = readFileSync(TEMPLATES_PATH, "utf8");
  const templates = JSON.parse(raw) as Template[];
  const violations: Violation[] = [];
  for (const t of templates) {
    for (const r of t.recipes ?? []) {
      violations.push(...lintIntentKeywords(t.slug, r));
      violations.push(...lintCategory(t.slug, r));
      violations.push(...lintSampleInputAlignment(t.slug, r));
      violations.push(...lintRequiredConnectors(t.slug, r));
    }
  }
  const solutions = JSON.parse(readFileSync(SOLUTIONS_PATH, "utf8")) as Recipe[];
  const templateSlugs = new Set(templates.map((t) => t.slug));
  for (const r of solutions) {
    violations.push(...lintIntentKeywords(SOLUTIONS, r));
    violations.push(...lintCategory(SOLUTIONS, r));
    violations.push(...lintSampleInputAlignment(SOLUTIONS, r));
    violations.push(...lintRequiredConnectors(SOLUTIONS, r));
    violations.push(...lintSolution(r, templateSlugs));
  }
  violations.push(...lintPrimitiveCoverage(templates));
  if (violations.length === 0) {
    console.log(
      `recipe-lint: OK (${templates.length} templates, ${solutions.length} solutions scanned)`,
    );
    return;
  }
  for (const v of violations) {
    console.error(`  ${v.template}/${v.recipe}: ${v.rule}: ${v.message}`);
  }
  console.error(`recipe-lint: ${violations.length} violation(s)`);
  process.exit(1);
}

main();
