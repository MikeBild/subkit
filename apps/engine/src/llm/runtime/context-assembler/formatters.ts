import { neutralizeDelimiters, wrapUntrusted } from "@shared/untrusted-content.ts";
import type { OperatorQuirkCategory, OperatorQuirks } from "../../../connectors/types.ts";
import type { SchemaShape } from "../../../self-healing/types.ts";
import type {
  ActiveConventions,
  AppliedConvention,
  ConventionConflict,
} from "../../../skills/conventions.ts";
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
import type { ConnectorSchemaSummary, InteractionLogEntry, LatestPreviewEntry } from "./loaders.ts";

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

export function formatSkillIndex(
  label: string,
  skills: Skill[],
  runtime_context?: AssembleContextParams["runtime_context"],
  mode: "interactive" | "catalog" | "guidance" = "interactive",
): string | null {
  if (skills.length === 0) return null;
  if (mode === "guidance") {
    return [
      `# ${label} approved skill guidance for schema generation`,
      "The complete approved guidance follows. Preserve its applicable domain constraints, security rules, data handling and workflow semantics. Any interactive tool procedure it describes belongs to the outer authoring agent; it does not add tools to this nested generation call.",
      ...skills.map((skill) => formatSkill(skill, runtime_context)),
      "This nested call emits the requested structured definition only. It cannot discover schemas or invoke author_workflow. A skill the index marks `load on demand` arrives only after an abort with a `skill_guidance` need naming it. If a required fact or contract is absent, use abort to name the exact missing fact and the evidence the outer agent must supply; never invent it.",
    ].join("\n\n");
  }
  const lines = skills.map((s) => {
    const ref = s.slug ?? s.id;
    const stated = s.description?.replace(/\s+/g, " ").trim();
    const firstLine =
      stated ||
      (applyRuntimeTemplate(s.body, runtime_context)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("#")) ??
        "");
    const desc = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
    return `- \`${ref}\` — ${s.title}${desc.length > 0 ? `: ${desc}` : ""}`;
  });
  const title =
    mode === "interactive"
      ? `# ${label} skill index — call \`load_skill('<slug>')\` for any of these`
      : `# ${label} skill catalog — descriptions only; no retrieval tool is available in this generation call`;
  return [title, ...lines].join("\n");
}

export function countSkillTokens(
  s: Skill,
  runtime_context?: AssembleContextParams["runtime_context"],
): number {
  return countTokens(formatSkill(s, runtime_context));
}

function fetchedAtSuffix(fetched_at: string | null): string {
  if (!fetched_at) return "";
  const date = fetched_at.slice(0, 10);
  return ` (fetched ${date})`;
}

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
    const metaParts: string[] = [];
    if (category) metaParts.push(`category: ${category}`);
    if (tags.length > 0) metaParts.push(`tags: ${tags.join(", ")}`);
    if (difficulty && difficulty !== "intermediate") {
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
  return `${neutralizeDelimiters(heading)}${fetchedAtSuffix(chunk.fetched_at)}\n${wrapUntrusted("web", chunk.snippet)}`;
}

export function formatKnowledgeChunk(chunk: IncludedKnowledgeChunk): string {
  const locator = chunk.title
    ? `${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : (chunk.path ?? "");
  const heading = locator
    ? `## Knowledge: ${chunk.source_name} — ${locator}`
    : `## Knowledge: ${chunk.source_name}`;
  const about = chunk.source_description?.replace(/\s+/g, " ").trim();
  const aboutLine = about
    ? `\nSource is about: ${about.length > 160 ? `${about.slice(0, 159).trimEnd()}…` : about}`
    : "";
  return `${neutralizeDelimiters(`${heading}${fetchedAtSuffix(chunk.fetched_at)}${aboutLine}`)}\n${wrapUntrusted("knowledge", chunk.snippet)}`;
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

export function formatLatestPreview(entries: LatestPreviewEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
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

export const PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR = 4;
export const PROBE_SHAPE_MAX_CONNECTORS = 5;
const PROBE_SHAPE_SUMMARY_MAX_CHARS = 2400;
const PROBE_SHAPE_SECTION_MAX_CHARS = 8000;
const PROBE_SHAPE_SUMMARY_MIN_CHARS = 360;
const PROBE_SHAPE_MAX_OBJECT_KEYS = 48;
const PROBE_SHAPE_MAX_DEPTH = 5;

export interface ProbeShapeExample {
  connector_slug: string;
  endpoint_key: string;
  shape: SchemaShape;
}

export function summarizeShape(
  shape: SchemaShape,
  depth = 0,
  maxDepth = PROBE_SHAPE_MAX_DEPTH,
  grouped = false,
): string {
  if (shape.type === "array") {
    return `array<${summarizeShape(shape.items, depth + 1, maxDepth, grouped)}>`;
  }
  if (shape.type === "object") {
    const keys = Object.keys(shape.properties);
    if (depth >= maxDepth) return keys.length > 0 ? "object{…}" : "object";
    const shown = keys.slice(0, PROBE_SHAPE_MAX_OBJECT_KEYS);
    const more = keys.length > shown.length ? `, …+${keys.length - shown.length} more` : "";
    if (shown.length === 0) return "object";
    const rendered = shown.map((k) => {
      const child = shape.properties[k];
      return [k, child ? summarizeShape(child, depth + 1, maxDepth, grouped) : "unknown"] as const;
    });
    if (grouped) {
      const groups = new Map<string, string[]>();
      for (const [k, summary] of rendered) {
        const names = groups.get(summary);
        if (names) names.push(k);
        else groups.set(summary, [k]);
      }
      const body = [...groups.entries()]
        .map(([summary, names]) => `${names.join(", ")}: ${summary}`)
        .join(", ");
      return `{ ${body}${more} }`;
    }
    return `{ ${rendered.map(([k, summary]) => `${k}: ${summary}`).join(", ")}${more} }`;
  }
  return shape.type;
}

export function fitShapeSummary(shape: SchemaShape, maxChars: number): string {
  const attempts: Array<[number, boolean]> = [
    [PROBE_SHAPE_MAX_DEPTH, false],
    [PROBE_SHAPE_MAX_DEPTH, true],
    [4, true],
    [3, true],
    [2, true],
    [1, true],
  ];
  let last = "";
  for (const [maxDepth, grouped] of attempts) {
    last = summarizeShape(shape, 0, maxDepth, grouped);
    if (last.length <= maxChars) return last;
  }
  return `${last.slice(0, maxChars)}…`;
}

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
  const selected = [...byConnector.entries()]
    .slice(0, PROBE_SHAPE_MAX_CONNECTORS)
    .map(
      ([slug, bucket]) => [slug, bucket.slice(0, PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR)] as const,
    );
  const total = selected.reduce((n, [, bucket]) => n + bucket.length, 0);
  const perEndpoint = Math.max(
    PROBE_SHAPE_SUMMARY_MIN_CHARS,
    Math.min(
      PROBE_SHAPE_SUMMARY_MAX_CHARS,
      Math.floor(PROBE_SHAPE_SECTION_MAX_CHARS / Math.max(total, 1)),
    ),
  );
  for (const [slug, bucket] of selected) {
    lines.push(`## ${slug}`);
    for (const example of bucket) {
      lines.push(`- ${example.endpoint_key}: ${fitShapeSummary(example.shape, perEndpoint)}`);
    }
  }
  return lines.join("\n");
}

export function formatConnectorSchemaSummaries(summaries: ConnectorSchemaSummary[]): string | null {
  if (summaries.length === 0) return null;
  const lines: string[] = [
    "# Connector operations (from the connector's schema)",
    "Operations available on this conversation's connector(s), introspected/discovered from the real schema, with argument names + types. Use these EXACT operation and argument names — do not invent or guess them.",
    "For deeper shapes the signatures don't show (enum VALUES, input-object fields, relay connection field layout), drill in with `search_knowledge` or `discover_connector_endpoints`.",
    "",
  ];
  for (const s of summaries) {
    lines.push(`## ${s.connector_slug}`);
    for (const op of s.operations) lines.push(`- ${op}`);
    if (s.self_description_line) lines.push(s.self_description_line);
  }
  return lines.join("\n");
}

export const RECIPE_BODIES_SECTION_CAP = 2000;

export const RECIPE_BODIES_TOP_K = 3;

export const RECIPE_BODY_HYBRID_SOFT_CAP = 800;

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

export function formatConnectorRecipeBodies(
  templateSlug: string,
  bodies: RecipeBodyView[],
): string | null {
  if (bodies.length === 0) return null;
  const rendered = bodies.map((body) => renderRecipeBody(body).text);
  return [
    `# Recipe bodies — connector \`${templateSlug}\``,
    "Top-K rich payloads for likely recipes. Clone via `start_workflow_from_recipe(template_slug, recipe_slug)` — no inspect_recipe round-trip needed when the workflow JSON is present below. Fall back to `inspect_recipe` only for elided bodies.",
    ...rendered,
  ].join("\n\n");
}

export const CONVENTIONS_SECTION_CAP = 600;

export const CONVENTIONS_HEADING = "# Applied conventions (Angewandte Konventionen)";

type ConventionsRenderMode = "interactive" | "generate";

function conventionLine(entry: AppliedConvention): string {
  return `- ${entry.rule.rule_id} [${entry.rule.type}] ${entry.rule.statement} ${JSON.stringify(entry.rule.payload)} (${entry.level} · ${entry.skill_title})`;
}

function conflictLine(conflict: ConventionConflict): string {
  return `- ${conflict.key} (${conflict.level}): ${conflict.conventions
    .map((entry) => `${entry.rule.rule_id} ${JSON.stringify(entry.rule.payload)}`)
    .join(" vs ")}`;
}

function omittedNote(omitted: AppliedConvention[], mode: ConventionsRenderMode): string {
  const titles = [...new Set(omitted.map((entry) => entry.skill_title))]
    .map((title) => `load_skill('${title}')`)
    .join(", ");
  return mode === "generate"
    ? `[${omitted.length} more convention${omitted.length === 1 ? "" : "s"} omitted for the section cap (${titles}); if the draft depends on one, abort and ask the outer agent to supply it.]`
    : `[${omitted.length} more convention${omitted.length === 1 ? "" : "s"} omitted for the section cap; read them with ${titles}.]`;
}

interface ConventionsSection {
  section: string;
  included: AppliedConvention[];
}

export function formatAppliedConventions(
  active: ActiveConventions,
  mode: ConventionsRenderMode,
): ConventionsSection | null {
  if (active.conventions.length === 0) return null;
  const head = [
    CONVENTIONS_HEADING,
    "Confirmed tenant conventions, most specific first (workflow, connector, global). Apply each one the draft touches while authoring, e.g. write the timezone rule's value as `tz` on schedule triggers. They shape the definition only; nothing here runs at execution time. Name the rule_id when you rely on one.",
  ];
  const conflicts =
    active.conflicts.length > 0
      ? [
          "Conflicting conventions at the same level. Do not pick one; ask the person which applies:",
          ...active.conflicts.map(conflictLine),
        ]
      : [];
  const render = (kept: AppliedConvention[], omitted: AppliedConvention[]) =>
    [
      ...head,
      ...conflicts,
      ...kept.map(conventionLine),
      ...(omitted.length > 0 ? [omittedNote(omitted, mode)] : []),
    ].join("\n");
  const kept = [...active.conventions];
  const omitted: AppliedConvention[] = [];
  let text = render(kept, omitted);
  while (kept.length > 0 && countTokens(text) > CONVENTIONS_SECTION_CAP) {
    const last = kept.pop();
    if (last) omitted.unshift(last);
    text = render(kept, omitted);
  }
  return { section: text, included: kept };
}

export function conventionsTrimReference(
  active: ActiveConventions,
  mode: ConventionsRenderMode,
): string {
  return [CONVENTIONS_HEADING, omittedNote(active.conventions, mode)].join("\n");
}

const PRIOR_WORKFLOWS_SECTION_CAP = 1500;

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

function formatPriorWorkflows(refs: PriorWorkflowRef[]): string | null {
  if (refs.length === 0) return null;
  return [
    "### Prior workflows [reference, not template]",
    "Compressed shapes of this tenant's most similar active workflows. Use to understand existing patterns, naming, and trigger choices — DO NOT clone these as templates. To create a new workflow, call `author_workflow` (or `start_workflow_from_recipe` when a connector recipe applies).",
    ...refs.map(renderPriorWorkflowRef),
  ].join("\n\n");
}

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

export function formatInteractionLog(entries: InteractionLogEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
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
