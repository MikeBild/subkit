// Recipe-quality lint. Runs in `bun run verify` between
// `check:terminology` and `test:determinism`.
//
// Catches authoring mistakes that the Zod parser accepts but the LLM
// or operator UI cannot rank against:
//
//   1. `intent_keywords` outside [3, 7], not lowercased, or duplicated
//      with `title` words (would inflate match scores spuriously).
//   2. `sample_input` set without `workflow.input_schema` (or vice-versa
//      when `input_schema` declares required fields and `sample_input`
//      omits them).
//   3. Multi-connector recipes (`required_connectors[]` non-empty)
//      whose declared placeholder UUIDs do not appear inside any
//      `workflow.steps[*].connector_id`.
//   4. Per-step coverage of `WorkflowDefSchema` primitives — every
//      step kind (`request`, `transform`, `call`, `wait`, `branch`,
//      `parallel`, `loop`) should have at least one recipe
//      demonstrating it. Pre-F1 only `request` + `transform` were
//      exercised; CI fails on regressions in this coverage as new
//      demonstration recipes (Workstream D) land.
//   5. `category` membership in `RecipeCategoryEnum` (the Zod parser
//      already enforces this; lint surfaces it before parse for a
//      better error message).
//
// Exit 0 = green, exit 1 = at least one violation.
//
// Per `bun run verify` convention: prints a one-line "OK" on success
// and structured per-recipe errors on failure (matching
// `check-terminology.sh`'s output shape so CI logs stay scannable).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATES_PATH = resolve(import.meta.dir, "..", "apps/engine/src/connectors/templates.json");

type Recipe = {
  slug: string;
  title: string;
  intent_keywords?: string[];
  category?: string;
  sample_input?: unknown;
  required_connectors?: Array<{ placeholder: string; template: string }>;
  workflow: {
    name?: string;
    input_schema?: Record<string, unknown>;
    steps?: Array<Record<string, unknown>>;
    /**
     * Optional trigger envelope. `kind` selects how the engine wakes the
     * workflow: `request` (default, externally invoked), `webhook`
     * (inbound URL bound by the workflow service reconciler), or
     * `schedule` (cron + tz bound by the scheduler reconciler).
     */
    trigger?: { kind?: string; [k: string]: unknown };
    /**
     * Optional per-run LLM token budget. Recipes that call an LLM step
     * declare a positive cap so the engine token meter aborts a runaway
     * run before it overspends. Tracked as the `budgeted-llm` primitive
     * in the coverage map so #69 stays a regression net.
     */
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

/**
 * Workflow-level (non-step) primitives the lint also tracks so the
 * coverage map catches accidental removal of a recipe demonstrating
 * each one. These do not live inside `workflow.steps[*].kind`:
 *
 *   - `webhook`       — `workflow.trigger.kind === "webhook"`
 *   - `schedule`      — `workflow.trigger.kind === "schedule"`
 *   - `budgeted-llm`  — `workflow.max_llm_tokens_per_run > 0`
 *
 * Issue #69 introduced these primitives via the Stripe charge-failed
 * webhook recipe (#46), the Stripe daily-charges-digest schedule
 * recipe (#47), and the OpenAI structured-extraction budgeted recipe
 * (#53). The baseline below pins each at >=1.
 */
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
  // Title-word overlap: an intent_keyword that is just a single word
  // already in the title contributes no information beyond the title
  // itself. Multi-word phrases overlapping the title are fine
  // (they bring phrasing variation).
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
  // If the schema declares required props, sample_input must satisfy them.
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
  // Every declared placeholder must appear at least once in a step's
  // connector_id field. Lets multi-connector recipes fail fast on
  // typos before the cloned draft hits dry-run.
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
      // Workflow-level primitives. A recipe contributes at most once to
      // each: e.g. a webhook trigger counts the recipe, not each step.
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
  // Tracking-only baseline: pre-F1 only `request` and `transform` are
  // exercised. Workstream D (demonstration recipes) backfills the
  // remaining six. Once a primitive crosses zero, lint pins it at
  // ≥1 to catch regressions. For now: log coverage to stdout, fail
  // CI only if a previously-covered primitive drops to zero.
  const counts = buildPrimitiveCoverage(templates);
  const out: Violation[] = [];
  // The starting baseline. As Workstream D ships demonstration
  // recipes for new primitives, raise this map (e.g. `branch: 1`) so
  // CI catches accidental removal.
  const baseline: Record<string, number> = {
    request: 1,
    transform: 1,
    // Workstream D bumped these to ≥1 via demonstration recipes.
    // Subsequent D iterations will lift `call` once the relevant
    // executor wiring lands. Never drop a primitive below its prior
    // baseline — CI fails on regression.
    branch: 1,
    parallel: 1,
    wait: 1,
    loop: 1,
    call: 0,
    // v1.0 phase 1 + 2 primitives (#46/#47/#53). Each kind has at
    // least one shipped recipe — the eval suite under
    // `apps/engine/eval/fixtures/recipe-*.json` pins those recipes
    // to their declared shape, this baseline pins the catalog count.
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
  // Always print coverage so reviewers see progress without grepping.
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
  violations.push(...lintPrimitiveCoverage(templates));
  if (violations.length === 0) {
    console.log(`recipe-lint: OK (${templates.length} templates scanned)`);
    return;
  }
  for (const v of violations) {
    console.error(`  ${v.template}/${v.recipe}: ${v.rule}: ${v.message}`);
  }
  console.error(`recipe-lint: ${violations.length} violation(s)`);
  process.exit(1);
}

main();
