// Pure formatting helpers used by the context assembler. Every
// function takes already-loaded data and returns a markdown-ish
// section the system prompt embeds verbatim. No DB, no IO, no token
// budget enforcement — those live in the parent `context-assembler.ts`
// orchestrator and `loaders.ts`.

import type { OperatorQuirkCategory, OperatorQuirks } from "../../../connectors/types.ts";
import type { SchemaShape } from "../../../self-healing/types.ts";
import type { SkillCandidateView } from "../../../skill-candidates/types.ts";
import type { Skill } from "../../../skills/types.ts";
import type { PriorWorkflowRef } from "../../../workflows/prior-workflows.ts";
import { countTokens } from "../../accounting/index.ts";
import type {
  AssembleContextParams,
  AuthoringPromptHint,
  IncludedChunk,
  IncludedKnowledgeChunk,
  PriorFailure,
} from "../../types.ts";
import type { InteractionLogEntry, LatestPreviewEntry } from "./loaders.ts";

/**
 * Substitute whitelisted runtime-context tokens in a skill body at
 * assembly time, so the model never sees a `${engine_url}`-style
 * template it has to resolve itself. Only tokens whose keys match a
 * known runtime-context field are replaced; unknown tokens (e.g.
 * `${plaintext_key}`, `${cred.slack.token}`, `${input.path}`) are
 * passed through unchanged — the skill author still controls what
 * stays as a placeholder for the user to fill in later.
 *
 * Mirrors the pattern used by Anthropic's Claude Code CLI: concrete
 * environment values are pre-rendered into the system prompt once,
 * rather than leaving it to the model to splice runtime data.
 */
export function applyRuntimeTemplate(
  body: string,
  ctx?: AssembleContextParams["runtime_context"],
): string {
  if (!ctx || !body.includes("${")) return body;
  const subs: Record<string, string | undefined> = {
    engine_url: ctx.engine_url,
    tenant_slug: ctx.tenant_slug,
    actor_email: ctx.actor_email,
    actor_role: ctx.actor_role,
    surface: ctx.surface,
  };
  return body.replace(/\$\{([a-z_]+)\}/g, (whole, key: string) => {
    const value = subs[key];
    return typeof value === "string" && value.length > 0 ? value : whole;
  });
}

export function formatSkill(
  s: Skill,
  runtime_context?: AssembleContextParams["runtime_context"],
): string {
  const body = applyRuntimeTemplate(s.body, runtime_context);
  const bp = s.best_practices.length > 0 ? `\nBest practices: ${s.best_practices.join("; ")}` : "";
  const pit = s.pitfalls.length > 0 ? `\nPitfalls: ${s.pitfalls.join("; ")}` : "";
  const refs = s.doc_refs.length > 0 ? `\nDoc refs: ${s.doc_refs.join(", ")}` : "";
  const ex = s.examples.length > 0 ? `\nExamples:\n- ${s.examples.join("\n- ")}` : "";
  return `# Skill: ${s.title} (${s.scope})\n${body}${bp}${pit}${refs}${ex}`;
}

/**
 * Render a per-scope skill index — one block, one line per skill.
 * The LLM uses `load_skill(<slug-or-id>)` to pull the full body of
 * any entry it actually needs.
 *
 * Pattern mirrors the validated reference-impl shape: the system
 * prompt ships a tiny catalog (~one line per skill ≤ ~30 tokens)
 * instead of a per-skill summary block (~58 tokens each). For a
 * tenant with 50 skills the index costs ~1.5k tokens vs ~3k for
 * separate summary blocks; more importantly, the index is bounded
 * by skill count, not by each skill's first-line length.
 *
 * Pre-fix every applicable skill rendered with its full body
 * (~31k tokens / turn in session a128deba). Post-fix only
 * loaded_skills carry full bodies; ambient skills appear as one
 * line in this index.
 */
export function formatSkillIndex(
  label: string,
  skills: Skill[],
  runtime_context?: AssembleContextParams["runtime_context"],
): string | null {
  if (skills.length === 0) return null;
  const lines = skills.map((s) => {
    const ref = s.slug ?? s.id;
    const body = applyRuntimeTemplate(s.body, runtime_context);
    // First non-empty, non-heading line as a one-line description.
    const firstLine =
      body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("#")) ?? "";
    const desc = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
    return `- \`${ref}\` — ${s.title}${desc.length > 0 ? `: ${desc}` : ""}`;
  });
  return [`# ${label} skill index — call \`load_skill('<slug>')\` for any of these`, ...lines].join(
    "\n",
  );
}

/**
 * Public token-counter for an individual skill body using the same
 * formatter the assembler uses. Lets observability paths (e.g. the
 * dialog.turn_end log's top_skills_by_tokens breakdown) report a
 * per-skill weight without re-implementing formatSkill out-of-tree.
 */
export function countSkillTokens(
  s: Skill,
  runtime_context?: AssembleContextParams["runtime_context"],
): number {
  return countTokens(formatSkill(s, runtime_context));
}

function fetchedAtSuffix(fetched_at: string | null): string {
  if (!fetched_at) return "";
  // Trim to YYYY-MM-DD so the prompt header is compact and stable.
  const date = fetched_at.slice(0, 10);
  return ` (fetched ${date})`;
}

/**
 * Categorized operator quirks — short, imperative hints the operator
 * wants the model to treat as authoritative ("treat 422 as success on
 * /upsert", "always send `?api-version=2025-01-01`"). Lives in
 * `connectors.operator_quirks`. The block is opt-in (only rendered
 * when at least one selected category has content). Per-turn category
 * selection is a string concat outside the cached prefix so the cache
 * key stays stable across category swaps.
 *
 * Format keeps the connector slug + name visible so the model never
 * confuses quirks from two connectors that ended up in scope on the
 * same turn.
 */
export function formatOperatorQuirks(
  slug: string,
  name: string,
  quirks: OperatorQuirks,
  categories: ReadonlyArray<OperatorQuirkCategory>,
): string | null {
  const lines: string[] = [];
  for (const cat of categories) {
    const v = quirks[cat]?.trim();
    if (v) lines.push(`## ${cat}\n${v}`);
  }
  if (lines.length === 0) return null;
  return [`# Operator quirks — connector \`${slug}\` (${name})`, ...lines].join("\n");
}

/**
 * Render a slim recipe roster from a connector's `template_snapshot`.
 * Surfaces `slug + title + category + tags + difficulty + intent_keywords`
 * per recipe — never the workflow body, sample_input, or
 * expected_output_preview, which the LLM fetches on demand via
 * `inspect_recipe(template_slug, recipe_slug)` after narrowing to
 * 1-3 candidates. Cloning still goes through
 * `start_workflow_from_recipe(template_slug, recipe_slug)`.
 *
 * Token budget (per converse-pipeline memory rule): the per-turn
 * recipe block is shared with the tenant snapshot + skills index.
 * Adding category/tags/difficulty costs ~10 extra tokens per recipe
 * (≈5.7k catalog-wide), well within budget. Anything heavier
 * (description, sample_input, workflow body) MUST stay behind
 * `inspect_recipe`.
 *
 * Returns null when the snapshot ships no recipes so the assembler
 * skips emitting a dead header.
 */
// Cap on rendered recipe lines per connector. Defensive: today no connector
// ships more than ~18 recipes, but as the catalogue grows the per-turn block
// must stay bounded. When truncated, the LLM is directed to `inspect_recipe`
// to discover the rest.
export const RECIPE_LINES_BUDGET = 24;

export function formatConnectorRecipes(
  slug: string,
  snapshot: Record<string, unknown>,
): string | null {
  const raw = snapshot.recipes;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: string[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const recipeSlug = typeof rec.slug === "string" ? rec.slug : null;
    const title = typeof rec.title === "string" ? rec.title : null;
    if (!recipeSlug || !title) continue;
    const category = typeof rec.category === "string" ? rec.category : null;
    const difficulty = typeof rec.difficulty === "string" ? rec.difficulty : null;
    const tags = Array.isArray(rec.tags)
      ? (rec.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const kws = Array.isArray(rec.intent_keywords)
      ? (rec.intent_keywords as unknown[]).filter((k): k is string => typeof k === "string")
      : [];
    // Order: meta first (compact), then keywords (variable length).
    const metaParts: string[] = [];
    if (category) metaParts.push(`category: ${category}`);
    if (tags.length > 0) metaParts.push(`tags: ${tags.join(", ")}`);
    if (difficulty && difficulty !== "intermediate") {
      // Drop the default to save tokens — surface only when notable.
      metaParts.push(`difficulty: ${difficulty}`);
    }
    if (kws.length > 0) metaParts.push(`keywords: ${kws.join(", ")}`);
    const metaSuffix = metaParts.length > 0 ? ` — ${metaParts.join(" | ")}` : "";
    lines.push(`- \`${recipeSlug}\` — ${title}${metaSuffix}`);
  }
  if (lines.length === 0) return null;
  const truncated = lines.length > RECIPE_LINES_BUDGET;
  const visible = truncated ? lines.slice(0, RECIPE_LINES_BUDGET) : lines;
  const tail = truncated
    ? [
        `- _… and ${lines.length - RECIPE_LINES_BUDGET} more — call \`inspect_recipe(template_slug, recipe_slug)\` to discover_`,
      ]
    : [];
  return [
    `# Available recipes — connector \`${slug}\``,
    "Clone via `start_workflow_from_recipe(template_slug, recipe_slug)`. For description / sample_input / workflow shape before cloning, call `inspect_recipe(template_slug, recipe_slug)`.",
    ...visible,
    ...tail,
  ].join("\n");
}

/**
 * Pick which operator-quirk categories to surface this turn. Heuristic
 * driven by the structured `AuthoringPromptHint` (the only scoped
 * authoring signal the assembler reliably has) plus a `prior_failures`
 * boost. The plan's per-turn rules:
 *   - `propose_step kind=request` (workflow drafting/inspecting) →
 *     auth + pagination + rate_limit + general
 *   - `propose_step kind=transform` (workflow validating/previewing) →
 *     pagination + schema + general
 *   - error envelope received → error_handling + schema + general
 *   - everything else → general
 *
 * Rendering only the relevant slice trims ~40-90% of the legacy 4 KB
 * `operator_notes` blob on connectors with rich text.
 */
export function selectOperatorQuirkCategories(
  hint: AuthoringPromptHint | undefined,
  hasFailures: boolean,
): ReadonlyArray<OperatorQuirkCategory> {
  if (hasFailures) return ["error_handling", "schema", "general"];
  const stage = hint?.stage ?? "idle";
  switch (stage) {
    case "connector_targeted":
    case "connector_draft_started":
    case "connector_inspected":
    case "connector_validated":
    case "connector_authenticated":
    case "connector_probed":
      return ["auth", "general"];
    case "workflow_targeted":
    case "workflow_draft_started":
    case "workflow_inspected":
      return ["auth", "pagination", "rate_limit", "general"];
    case "workflow_validated":
    case "workflow_previewed":
      // Transform-shaped stage — only `schema` matters; pagination /
      // auth / rate_limit are irrelevant once the request graph is
      // fixed and the LLM is shaping the output. Pinned by the
      // quirk-token-budget eval.
      return ["schema", "general"];
    case "diagnosing":
    case "repairing":
      return ["error_handling", "schema", "general"];
    case "workflow_executed":
    case "workflow_persisted":
    case "connector_persisted":
    case "idle":
      return ["general"];
    default:
      return ["general"];
  }
}

export function formatChunk(chunk: IncludedChunk): string {
  const heading = chunk.title
    ? `## Doc: ${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : chunk.path
      ? `## Doc: ${chunk.path}`
      : "## Doc";
  return `${heading}${fetchedAtSuffix(chunk.fetched_at)}\n${chunk.snippet}`;
}

export function formatKnowledgeChunk(chunk: IncludedKnowledgeChunk): string {
  // Lead the heading with the named source so the model has provenance
  // ("which source covers X?"), then the chunk's title/path locator.
  const locator = chunk.title
    ? `${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : (chunk.path ?? "");
  const heading = locator
    ? `## Knowledge: ${chunk.source_name} — ${locator}`
    : `## Knowledge: ${chunk.source_name}`;
  return `${heading}${fetchedAtSuffix(chunk.fetched_at)}\n${chunk.snippet}`;
}

export function formatFailure(f: PriorFailure): string {
  const parts = [`## Prior failure: ${f.step_id}`, f.error];
  if (f.schema_diff) parts.push(`schema diff:\n${f.schema_diff}`);
  if (f.captured_response) parts.push(`captured response:\n${f.captured_response}`);
  return parts.join("\n");
}

export function formatUserMemory(s: string): string {
  return `# User memory\n${s}`;
}

/**
 * Render the latest_preview slot. The model reads this to author the
 * next transform / loop / branch path against real shapes instead of
 * guessing. Lines are intentionally terse — the model just needs the
 * shape vocabulary, not the full preview body (which lives on
 * inspect_workflow_draft / suggest_jsonata_paths).
 */
export function formatLatestPreview(entries: LatestPreviewEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    // The addressing label uses the same vocabulary as the scope
    // manifest and the "Recorded endpoint samples" section so the
    // model reads ONE addressing form everywhere: a step's recorded
    // output is reachable as `$scope.<step_id>.data…`.
    const parts: string[] = [
      `- ${e.step_id} (${e.kind}) → ${e.status} · addressable as \`$scope.${e.step_id}.data…\``,
    ];
    if (e.shape_summary) parts.push(`shape=${e.shape_summary}`);
    if (e.primary_data_path) parts.push(`primary=\`${e.primary_data_path}\``);
    if (e.available_paths && e.available_paths.length > 0) {
      parts.push(`paths=[${e.available_paths.map((p) => `\`${p}\``).join(", ")}]`);
    }
    if (e.error_code) parts.push(`error=${e.error_code}`);
    return parts.join(" · ");
  });
  return [
    "# Latest preview",
    "Compact per-step view of the most recent dry_run / run for this conversation.",
    "Author downstream `$scope.<step>.<path>` references against the listed `paths` — never guess.",
    "Call `suggest_jsonata_paths` for full path candidates or `inspect_workflow_draft` for the per-step output_preview.",
    "",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Recorded endpoint samples — payload-first generation context
// ---------------------------------------------------------------------------

/** Endpoints rendered per connector in the samples section. */
export const PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR = 4;
/** Connectors rendered in the samples section. */
export const PROBE_SHAPE_MAX_CONNECTORS = 5;
/** Per-endpoint cap on the rendered shape summary. Together with the
 *  connector/endpoint caps this bounds the whole section at
 *  ~5 × 4 × 360 chars ≈ 7 KB worst case, well under the early-drop
 *  ladder position the assembler gives it. */
const PROBE_SHAPE_SUMMARY_MAX_CHARS = 360;
const PROBE_SHAPE_MAX_OBJECT_KEYS = 8;
const PROBE_SHAPE_MAX_DEPTH = 3;

/** One recorded endpoint shape, ready to render. Loaded by
 *  `loadProbeShapeExamples` from the `schema_versions` store. */
export interface ProbeShapeExample {
  connector_slug: string;
  endpoint_key: string;
  shape: SchemaShape;
}

/**
 * Render a `SchemaShape` as a compact one-line type summary, e.g.
 * `{ droplets: array<{ id: number, name: string }>, meta: object{…} }`.
 * Depth- and key-capped so a deeply nested vendor payload can't blow
 * the prompt budget; the model only needs the field vocabulary.
 */
export function summarizeShape(shape: SchemaShape, depth = 0): string {
  if (shape.type === "array") {
    return `array<${summarizeShape(shape.items, depth + 1)}>`;
  }
  if (shape.type === "object") {
    const keys = Object.keys(shape.properties);
    if (depth >= PROBE_SHAPE_MAX_DEPTH) return keys.length > 0 ? "object{…}" : "object";
    const shown = keys.slice(0, PROBE_SHAPE_MAX_OBJECT_KEYS);
    const more = keys.length > shown.length ? `, …+${keys.length - shown.length} more` : "";
    if (shown.length === 0) return "object";
    const body = shown
      .map((k) => {
        const child = shape.properties[k];
        return `${k}: ${child ? summarizeShape(child, depth + 1) : "unknown"}`;
      })
      .join(", ");
    return `{ ${body}${more} }`;
  }
  return shape.type;
}

/**
 * Render the "Recorded endpoint samples" section — the latest observed
 * response shapes (recorded by `probe_connector`, `call_connector`, and
 * request-step executions) for the connectors bound to the active
 * draft. Payload-first authoring: the model grounds request paths and
 * transform field names in shapes it has actually seen BEFORE writing
 * them, instead of validating after the fact.
 */
export function formatProbeShapeExamples(examples: ProbeShapeExample[]): string | null {
  if (examples.length === 0) return null;
  const byConnector = new Map<string, ProbeShapeExample[]>();
  for (const example of examples) {
    const bucket = byConnector.get(example.connector_slug);
    if (bucket) bucket.push(example);
    else byConnector.set(example.connector_slug, [example]);
  }
  const lines: string[] = [
    "# Recorded endpoint samples",
    "Latest response shapes recorded from real calls (probes, call_connector, request steps) against this conversation's connectors.",
    "Ground request paths and transform field names in these shapes — use the field names verbatim, never invent fields.",
    "Once a step runs in a preview, its recorded output is addressable as `$scope.<step_id>.data…`.",
    "",
  ];
  for (const [slug, bucket] of [...byConnector.entries()].slice(0, PROBE_SHAPE_MAX_CONNECTORS)) {
    lines.push(`## ${slug}`);
    for (const example of bucket.slice(0, PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR)) {
      let summary = summarizeShape(example.shape);
      if (summary.length > PROBE_SHAPE_SUMMARY_MAX_CHARS) {
        summary = `${summary.slice(0, PROBE_SHAPE_SUMMARY_MAX_CHARS)}…`;
      }
      lines.push(`- ${example.endpoint_key}: ${summary}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Recipe bodies + Skill candidates — context for in-flight authoring
// ---------------------------------------------------------------------------

/**
 * Module-private section caps. Tuning these is a source change — not a
 * runtime knob, not an env flag, not a config knob. Mirrors the existing
 * `RECIPE_LINES_BUDGET` discipline.
 */
export const RECIPE_BODIES_SECTION_CAP = 2000;
export const SKILL_CANDIDATES_SECTION_CAP = 1200;

/**
 * Hard cap on the number of recipe bodies the assembler ever materialises
 * for a single authoring turn. Pairs with `RECIPE_BODIES_SECTION_CAP`
 * (token-level bound); this is the first-level item-count bound.
 */
export const RECIPE_BODIES_TOP_K = 3;

/** Soft per-item cap before the full workflow JSON is elided in favor
 *  of the hybrid (description + prerequisites + required_connectors +
 *  sample_input) payload. Chosen because the p90 recipe workflow in
 *  `templates.json` is ~600 tokens; `required_connectors` is ≤ 80 tokens
 *  even for 5-connector recipes. */
export const RECIPE_BODY_HYBRID_SOFT_CAP = 800;

/** Compact view of a connector recipe ready for the rich body block.
 *  Built by `loadTopRecipeBodies` (loaders.ts) — pure over the snapshot
 *  the assembler already loaded. Workflow stays as `unknown` because
 *  `connectors/templates.ts` exposes it as `WorkflowDef` via a refine —
 *  we serialize via JSON.stringify, never read individual fields. */
export interface RecipeBodyView {
  template_slug: string;
  recipe_slug: string;
  title: string;
  description: string;
  prerequisites: string[];
  required_connectors: Array<{ placeholder: string; template: string }>;
  sample_input: unknown;
  workflow: unknown;
}

/** Render a single recipe body as a markdown fragment. Returns the
 *  rendered string AND a `fellBack` flag so the caller can emit the
 *  `llm.context.recipe_body_fallback` warning log when the hybrid path
 *  triggered. Pure — no logging happens here so trim loops in loaders.ts
 *  can render-and-count freely without emitting duplicate warnings. */
export function renderRecipeBody(view: RecipeBodyView): { text: string; fellBack: boolean } {
  const prereqLines =
    view.prerequisites.length > 0
      ? `Prerequisites: ${view.prerequisites.join("; ")}`
      : "Prerequisites: (none)";
  const reqConnLines =
    view.required_connectors.length > 0
      ? `Required connectors: ${view.required_connectors
          .map((rc) => `${rc.template} (placeholder ${rc.placeholder})`)
          .join("; ")}`
      : "Required connectors: single-connector recipe";
  const sampleInputBlock =
    view.sample_input == null
      ? "Sample input: (none)"
      : `Sample input:\n\`\`\`json\n${JSON.stringify(view.sample_input, null, 2)}\n\`\`\``;

  const workflowJson = JSON.stringify(view.workflow);
  const fullCandidate = [
    `## Recipe \`${view.recipe_slug}\` — ${view.title}`,
    view.description,
    prereqLines,
    reqConnLines,
    sampleInputBlock,
    `Workflow:\n\`\`\`json\n${workflowJson}\n\`\`\``,
  ].join("\n");

  if (countTokens(fullCandidate) <= RECIPE_BODY_HYBRID_SOFT_CAP) {
    return { text: fullCandidate, fellBack: false };
  }

  // Hybrid fallback — drop the workflow JSON but keep
  // required_connectors (load-bearing for multi-connector recipes).
  const hybrid = [
    `## Recipe \`${view.recipe_slug}\` — ${view.title}`,
    view.description,
    prereqLines,
    reqConnLines,
    sampleInputBlock,
    `_workflow body elided — call inspect_recipe("${view.template_slug}", "${view.recipe_slug}") for full shape_`,
  ].join("\n");
  return { text: hybrid, fellBack: true };
}

/** Format the recipe-bodies section. Returns null on empty input so the
 *  assembler can omit the dead header (mirrors `formatConnectorRecipes`).
 *
 *  Pure — no logging happens here. The trim loop in loaders.ts may
 *  call this repeatedly during render-and-count, so the
 *  `llm.context.recipe_body_fallback` warning is emitted by the loader
 *  exactly once per survivor in the final set. */
export function formatConnectorRecipeBodies(
  templateSlug: string,
  bodies: RecipeBodyView[],
): string | null {
  if (bodies.length === 0) return null;
  // Pure: no mutation of input. logRecipeBodyFallbacks re-invokes
  // renderRecipeBody for each survivor at the end of assembly — the
  // cost is bounded (N ≤ top-K = 3) and renderRecipeBody is
  // deterministic.
  const rendered = bodies.map((body) => renderRecipeBody(body).text);
  return [
    `# Recipe bodies — connector \`${templateSlug}\``,
    "Top-K rich payloads for likely recipes. Clone via `start_workflow_from_recipe(template_slug, recipe_slug)` — no inspect_recipe round-trip needed when the workflow JSON is present below. Fall back to `inspect_recipe` only for elided bodies.",
    ...rendered,
  ].join("\n\n");
}

/** Format a single skill-candidate body. */
function renderSkillCandidate(c: SkillCandidateView): string {
  const meta: string[] = [`scope=${c.scope}`, `confidence=${c.confidence}`];
  if (c.connector_id) meta.push(`connector_id=${c.connector_id}`);
  if (c.workflow_id) meta.push(`workflow_id=${c.workflow_id}`);
  meta.push(`evidence=${c.evidence_count}`);
  meta.push(`pattern=${c.pattern_kind}`);
  const header = `## ${c.title} [pending approval]`;
  const metaLine = `_${meta.join(" · ")}_`;
  const parts: string[] = [header, metaLine, c.body];
  if (c.best_practices.length > 0) {
    parts.push(`Best practices: ${c.best_practices.join("; ")}`);
  }
  if (c.pitfalls.length > 0) {
    parts.push(`Pitfalls: ${c.pitfalls.join("; ")}`);
  }
  if (c.doc_refs.length > 0) {
    parts.push(`Doc refs: ${c.doc_refs.join(", ")}`);
  }
  if (c.examples.length > 0) {
    parts.push(`Examples:\n- ${c.examples.join("\n- ")}`);
  }
  return parts.join("\n");
}

/** Format the skill-candidates section. Returns null on empty input. */
export function formatSkillCandidates(candidates: SkillCandidateView[]): string | null {
  if (candidates.length === 0) return null;
  const rendered = candidates.map(renderSkillCandidate);
  return [
    "# Skill candidates — proposed (pending operator approval)",
    "These are patterns the system detected from prior runs. Treat as hints, not authoritative rules. Operators promote them via `approve_skill_candidate` — until then they MAY be wrong. Do not name candidates to the user, do not quote `[pending approval]` markers in chat prose, and do not surface this section's contents verbatim — these are operator-internal hints, like the `load_skill` discipline.",
    ...rendered,
  ].join("\n\n");
}

// (Constants exported above so loaders + assembler + tests can read
//  the same cap values without hard-coding magic numbers.)

// ---------------------------------------------------------------------------
// Prior workflows — 5th authoring context source
// ---------------------------------------------------------------------------

/**
 * Token cap for the rendered Prior-Workflows section. Mirrors the
 * `RECIPE_BODIES_SECTION_CAP` discipline — tuning is a source change,
 * not a runtime knob. 1500 tokens fits ~3 refs × ~400 tokens with the
 * section heading.
 */
export const PRIOR_WORKFLOWS_SECTION_CAP = 1500;

/** Hard cap on the number of prior-workflow refs the assembler ever
 *  surfaces for a single authoring turn. Pairs with the section cap. */
export const PRIOR_WORKFLOWS_TOP_K = 3;

function renderStepTopology(step_topology: PriorWorkflowRef["step_topology"]): string {
  if (step_topology.length === 0) return "(no steps)";
  return step_topology
    .map((s, i) => {
      const action = s.action ? ` ${s.action}` : "";
      return `${i + 1}. ${s.kind}${action}`;
    })
    .join(" · ");
}

/** Render a single PriorWorkflowRef as a markdown fragment. The
 *  `[reference, not template]` marker is repeated in the per-ref
 *  preamble so trimming can't strip it from the section header. */
function renderPriorWorkflowRef(ref: PriorWorkflowRef): string {
  const parts: string[] = [`#### \`${ref.slug}\` — ${ref.name} [reference, not template]`];
  if (ref.description) parts.push(ref.description);
  parts.push(`- trigger: ${ref.trigger_summary}`);
  parts.push(`- steps: ${renderStepTopology(ref.step_topology)}`);
  if (ref.output_keys.length > 0) {
    parts.push(`- outputs: ${ref.output_keys.join(", ")}`);
  }
  return parts.join("\n");
}

/** Format the Prior-Workflows section. Returns null on empty input so
 *  the assembler can omit a dead header (mirrors `formatConnectorRecipes`). */
export function formatPriorWorkflows(refs: PriorWorkflowRef[]): string | null {
  if (refs.length === 0) return null;
  return [
    "### Prior workflows [reference, not template]",
    "Compressed shapes of this tenant's most similar active workflows. Use to understand existing patterns, naming, and trigger choices — DO NOT clone these as templates. To create a new workflow, call `build_workflow` (or `start_workflow_from_recipe` when a connector recipe applies).",
    ...refs.map(renderPriorWorkflowRef),
  ].join("\n\n");
}

/**
 * Render-and-count trim: drop the lowest-ranked prior-workflow refs
 * one at a time until the section fits the cap. Mirrors
 * `trimRecipeBodiesToBudget`. Returns the surviving list, the rendered
 * section (or null if everything was dropped), and the trim count.
 *
 * When at least one ref was dropped an elision notice is appended so
 * the model sees there were more candidates.
 */
export function trimPriorWorkflowsToBudget(refs: PriorWorkflowRef[]): {
  survivors: PriorWorkflowRef[];
  section: string | null;
  trimmed: number;
} {
  if (refs.length === 0) return { survivors: [], section: null, trimmed: 0 };
  const survivors = [...refs];
  let trimmed = 0;
  while (survivors.length > 0) {
    const sectionBase = formatPriorWorkflows(survivors);
    if (sectionBase === null) break;
    const notice =
      trimmed > 0
        ? `\n\n_${trimmed} more prior workflow${trimmed === 1 ? "" : "s"} elided — token budget_`
        : "";
    const candidate = `${sectionBase}${notice}`;
    if (countTokens(candidate) <= PRIOR_WORKFLOWS_SECTION_CAP) {
      return { survivors, section: candidate, trimmed };
    }
    survivors.pop();
    trimmed += 1;
  }
  return { survivors: [], section: null, trimmed };
}

/**
 * Render the interaction log as a markdown section. Gives the model an
 * append-only record of "what was tested vs. confirmed vs. declined"
 * so it doesn't re-ask for already-resolved actions or treat a
 * partial approval as full.
 */
export function formatInteractionLog(entries: InteractionLogEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    // Prefer the operator's free-text `feedback` (the prose they typed);
    // fall back to the machine-code `decision_reason` when no feedback
    // was given. Reading only `decision_reason` would surface a stable
    // token like `user_declined` instead of the operator's actual words.
    const note = e.feedback ?? e.decision_reason;
    const suffix = note ? ` (${note})` : "";
    return `- ${e.tool_name} → ${e.decision}${suffix}`;
  });
  return [
    "# Interaction log",
    "Append-only record of the recent confirmations and elicitations in this conversation.",
    "Read this before re-asking for any action: if a tool was already declined this turn, do NOT retry without explicit user guidance; if it was already confirmed, do NOT re-ask.",
    "",
    ...lines,
  ].join("\n");
}
