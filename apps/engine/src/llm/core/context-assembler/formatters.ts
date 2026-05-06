// Pure formatting helpers used by the context assembler. Every
// function takes already-loaded data and returns a markdown-ish
// section the system prompt embeds verbatim. No DB, no IO, no token
// budget enforcement — those live in the parent `context-assembler.ts`
// orchestrator and `loaders.ts`.

import type { OperatorQuirkCategory, OperatorQuirks } from "../../../connectors/types.ts";
import type { Skill } from "../../../skills/types.ts";
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
  const heading = chunk.title
    ? `## Knowledge: ${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : chunk.path
      ? `## Knowledge: ${chunk.path}`
      : "## Knowledge";
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
    const parts: string[] = [`- ${e.step_id} (${e.kind}) → ${e.status}`];
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

/**
 * Render the interaction log as a markdown section. Mirrors the
 * reference impl's `interactionLog` array — gives the model an
 * append-only record of "what was tested vs. confirmed vs. declined"
 * so it doesn't re-ask for already-resolved actions or treat a
 * partial approval as full.
 */
export function formatInteractionLog(entries: InteractionLogEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    const reason = e.decision_reason ? ` (${e.decision_reason})` : "";
    return `- ${e.tool_name} → ${e.decision}${reason}`;
  });
  return [
    "# Interaction log",
    "Append-only record of the recent confirmations and elicitations in this conversation.",
    "Read this before re-asking for any action: if a tool was already declined this turn, do NOT retry without explicit user guidance; if it was already confirmed, do NOT re-ask.",
    "",
    ...lines,
  ].join("\n");
}
