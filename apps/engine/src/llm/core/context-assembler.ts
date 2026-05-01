// Context assembler — single entry point for LLM-bound prompt construction.
//
// Responsibilities:
//   1) Load applicable skills (global → connector → workflow scope)
//   2) Load connector docs + knowledge-source chunks via semantic search
//   3) Format sections (skills, docs, knowledge, failures, user memory)
//   4) Enforce a per-model token budget via js-tiktoken, gracefully
//      dropping lowest-priority sections until it fits (never the user
//      turn). The trimmed list is surfaced on the return value.
//   5) Split the resulting system prompt into stable + volatile cache
//      blocks so the provider can cache the head and recompute only the
//      tail each turn.
//
// Replaces the prior `llm/context.ts` implementation entirely — all
// callers now import from this module.

import { and, desc, eq } from "drizzle-orm";
import { getConnector } from "../../connectors/service.ts";
import { generateMainAgentSystemPrompt } from "../../conversations/agent/context.ts";
import type { Db } from "../../db/client.ts";
import { getDb } from "../../db/client.ts";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { searchDocs } from "../../docs-ingestion/service.ts";
import { searchKnowledge } from "../../knowledge/service.ts";
import { logger } from "../../logging/logger.ts";
import { recordLlmContextAssembled } from "../../observability/instrumentation.ts";
import {
  getSkill,
  getSkillBySlug,
  listAutoLoadSkills,
  listSkills,
  retrieveApplicableSkills,
} from "../../skills/service.ts";
import type { Skill } from "../../skills/types.ts";
import { LlmContextTooLarge } from "../errors.ts";
import { renderRuntimeContextBlock } from "../runtime-context.ts";
import { contextCapFor, countMessagesTokens, countTokens } from "../tokens.ts";
import type {
  AssembleContextParams,
  AuthoringPromptHint,
  EnhancedPrompt,
  IncludedChunk,
  IncludedKnowledgeChunk,
  LlmFlow,
  PriorFailure,
  UserTurn,
} from "../types.ts";
import { type CacheBlocks, splitPromptIntoBlocks } from "./cache-blocks.ts";
import { loadTenantSummary, renderTenantSummaryBlock } from "./tenant-summary.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConversationSurface = "sk_headless" | "sk_interactive" | "mcp" | "web";

// Live-data assembly only. The structural prompt body (persona,
// behaviour skills, authoring-focus blocks) is owned by the agent
// registry — see `apps/engine/src/conversations/agent/context.ts`.
//
// `basePromptFor` and `BASE_SYSTEM_PROMPTS` remain the entry point
// for one-shot flows (`generate`, `extract`, `repair`, `summarize`,
// `discover`) that don't go through the conversation agent. The
// `converse` flow asks the MAIN agent registry for its system prompt
// instead — `assembleEnhancedPrompt` calls
// `generateMainAgentSystemPrompt` and uses the result verbatim.

const BASE_SYSTEM_PROMPTS: Record<Exclude<LlmFlow, "converse">, string> = {
  generate: [
    "You are the subkit workflow engine's generate flow.",
    "Turn the user's description into a typed WorkflowDef draft.",
    "A WorkflowDef has a `name`, optional `slug` / `description`, and an ordered `steps[]` array.",
    "Each step has `kind` (one of: request, transform, call, wait, branch, parallel, loop, tool) and a unique `id`.",
    "Prefer `request` steps with `connector_id` + `path` when a connector is in scope.",
    "Always ground your draft in the provided Skills and connector docs. Never invent endpoints or parameters.",
    "Emit exactly one JSON object matching the WorkflowDef schema. No surrounding prose.",
  ].join(" "),
  extract: [
    "You are the subkit workflow engine's extract flow.",
    "Read the user's sample and emit a canonical JSON representation of the structured fields it contains.",
    "Respect the optional target hint when provided; otherwise infer the tightest schema that fits the sample.",
    "Return one JSON object with a `schema` field describing field names and types, and a `data` field with the extracted values.",
  ].join(" "),
  repair: [
    "You are the subkit workflow engine's repair flow.",
    "A step has failed and you are given the diff between the captured response and the last known schema.",
    "Propose the smallest possible patch that will make the step compatible with the new response shape.",
    "Classify the patch as `safe` (schema-only), `risky` (semantic), or `blocked` (requires human review).",
    "Return one JSON object with `patch`, `classification`, and `notes`.",
  ].join(" "),
  discover: [
    "You are the subkit workflow engine's discovery flow.",
    "Analyze the given file content to identify three kinds of artifacts:",
    "1. Connectors: API integrations (from OpenAPI specs, code with API calls, config files with connection strings).",
    "2. Skills: operational rules, compliance requirements, best practices (from SOP documents, compliance docs).",
    "3. Knowledge Sources: reference material that should be indexed for retrieval (from runbooks, glossaries).",
    "For each artifact, provide: kind, title, description, structured draft data, evidence excerpts, and a confidence score (0-100).",
    "Be precise. Only propose artifacts you have strong evidence for. Never invent URLs, endpoints, or credentials.",
    "Return a JSON object with an `artifacts` array.",
  ].join(" "),
  summarize: [
    "You are the subkit workflow engine's summarize flow.",
    "Compress the user's input into a short operator-facing summary.",
    "Keep the result factual, compact, and plain text.",
    "Do not add markdown headings, bullet lists, or JSON unless the user explicitly asks for them.",
  ].join(" "),
};

/**
 * Return the system prompt body for a one-shot flow. The `converse`
 * flow does NOT pass through this — it asks the agent registry for
 * its prompt directly. We keep the function exported with a `converse`
 * branch only so legacy callers (tests, eval fixtures) that ask for
 * the converse base get a small helpful fallback rather than throwing.
 */
export async function basePromptFor(
  flow: LlmFlow,
  surface?: ConversationSurface,
  authoringHint?: AuthoringPromptHint,
): Promise<string> {
  if (flow === "converse") {
    const result = await generateMainAgentSystemPrompt({
      ...(surface ? { surface } : {}),
      ...(authoringHint ? { authoring_hint: authoringHint } : {}),
    });
    return result.content;
  }
  return BASE_SYSTEM_PROMPTS[flow];
}

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

function formatSkill(s: Skill, runtime_context?: AssembleContextParams["runtime_context"]): string {
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
  quirks: import("../../connectors/types.ts").OperatorQuirks,
  categories: ReadonlyArray<import("../../connectors/types.ts").OperatorQuirkCategory>,
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
  return [
    `# Available recipes — connector \`${slug}\``,
    "Clone via `start_workflow_from_recipe(template_slug, recipe_slug)`. For description / sample_input / workflow shape before cloning, call `inspect_recipe(template_slug, recipe_slug)`.",
    ...lines,
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
  hint: import("../../llm/types.ts").AuthoringPromptHint | undefined,
  hasFailures: boolean,
): ReadonlyArray<import("../../connectors/types.ts").OperatorQuirkCategory> {
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

function formatChunk(chunk: IncludedChunk): string {
  const heading = chunk.title
    ? `## Doc: ${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : chunk.path
      ? `## Doc: ${chunk.path}`
      : "## Doc";
  return `${heading}${fetchedAtSuffix(chunk.fetched_at)}\n${chunk.snippet}`;
}

function formatKnowledgeChunk(chunk: IncludedKnowledgeChunk): string {
  const heading = chunk.title
    ? `## Knowledge: ${chunk.title}${chunk.path ? ` — ${chunk.path}` : ""}`
    : chunk.path
      ? `## Knowledge: ${chunk.path}`
      : "## Knowledge";
  return `${heading}${fetchedAtSuffix(chunk.fetched_at)}\n${chunk.snippet}`;
}

function formatFailure(f: PriorFailure): string {
  const parts = [`## Prior failure: ${f.step_id}`, f.error];
  if (f.schema_diff) parts.push(`schema diff:\n${f.schema_diff}`);
  if (f.captured_response) parts.push(`captured response:\n${f.captured_response}`);
  return parts.join("\n");
}

function formatUserMemory(s: string): string {
  return `# User memory\n${s}`;
}

interface InteractionLogEntry {
  tool_name: string;
  status: string;
  decision: string;
  decision_reason: string | null;
  decided_at: Date | null;
}

/**
 * Load the last N elicitations for a conversation in reverse-chronological
 * order, then reverse to chronological for display. We only surface
 * resolved/cancelled/timeout entries — pending elicitations are still
 * waiting for the user, so reading them as "decisions" would be wrong.
 *
 * Returns at most `limit` entries; conservative because the LLM only
 * needs the recent confirmation history, not the full audit trail.
 */
async function loadInteractionLog(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
  limit = 10,
): Promise<InteractionLogEntry[]> {
  try {
    const rows = await exec
      .select({
        tool_name: conversationElicitations.tool_name,
        status: conversationElicitations.status,
        output: conversationElicitations.output,
        decision_reason: conversationElicitations.decision_reason,
        decided_at: conversationElicitations.decided_at,
      })
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, tenant_id),
          eq(conversationElicitations.conversation_id, conversation_id),
        ),
      )
      .orderBy(desc(conversationElicitations.created_at))
      .limit(limit);
    const filtered = rows.filter((r) => r.status !== "pending");
    return filtered.reverse().map((r) => {
      const output = r.output as Record<string, unknown> | null;
      const confirmed = output?.confirmed === true;
      const partial = Array.isArray(output?.approved_indices);
      const decision = partial
        ? "partial"
        : confirmed
          ? "approved"
          : r.status === "resolved"
            ? "declined"
            : r.status;
      return {
        tool_name: r.tool_name,
        status: r.status,
        decision,
        decision_reason: r.decision_reason,
        decided_at: r.decided_at,
      };
    });
  } catch {
    return [];
  }
}

/** Compact preview entry surfaced to the model. */
interface LatestPreviewEntry {
  step_id: string;
  kind: string;
  status: string;
  shape_summary?: string;
  primary_data_path?: string | null;
  available_paths?: string[];
  error_code?: string;
}

/**
 * Read the most recent dry-run / run preview off the conversation's
 * persisted draft (`conversations.draft.latest_preview.step_traces`).
 * Compacted to step_id + kind + status + scope_at_step. The
 * authoring loop will reach for this before guessing a JSONata path
 * — no need to re-issue a dry_run just to remember the shape.
 */
async function loadLatestPreview(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
  limit = 12,
): Promise<LatestPreviewEntry[]> {
  try {
    const rows = await exec
      .select({ draft: conversations.draft })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
      .limit(1);
    const draft = rows[0]?.draft as
      | {
          latest_preview?: {
            step_traces?: Array<Record<string, unknown>>;
          };
        }
      | null
      | undefined;
    const traces = draft?.latest_preview?.step_traces;
    if (!Array.isArray(traces)) return [];
    const out: LatestPreviewEntry[] = [];
    for (const t of traces.slice(0, limit)) {
      if (!t || typeof t !== "object") continue;
      const stepId = (t as { step_id?: unknown }).step_id;
      const kind = (t as { kind?: unknown }).kind;
      const status = (t as { status?: unknown }).status;
      if (typeof stepId !== "string") continue;
      const scope = (t as { scope_at_step?: Record<string, unknown> }).scope_at_step;
      const errorCode = (t as { error_code?: unknown }).error_code;
      out.push({
        step_id: stepId,
        kind: typeof kind === "string" ? kind : "unknown",
        status: typeof status === "string" ? status : "unknown",
        ...(scope && typeof scope.shape_summary === "string"
          ? { shape_summary: scope.shape_summary }
          : {}),
        ...(scope &&
        (typeof scope.primary_data_path === "string" || scope.primary_data_path === null)
          ? { primary_data_path: scope.primary_data_path as string | null }
          : {}),
        ...(scope && Array.isArray(scope.available_paths)
          ? {
              available_paths: (scope.available_paths as unknown[])
                .filter((s): s is string => typeof s === "string")
                .slice(0, 8),
            }
          : {}),
        ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Render the latest_preview slot. The model reads this to author the
 * next transform / loop / branch path against real shapes instead of
 * guessing. Lines are intentionally terse — the model just needs the
 * shape vocabulary, not the full preview body (which lives on
 * inspect_workflow_draft / suggest_jsonata_paths).
 */
function formatLatestPreview(entries: LatestPreviewEntry[]): string {
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
function formatInteractionLog(entries: InteractionLogEntry[]): string {
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

function buildQuery(turns: UserTurn[]): string {
  const tail = turns.slice(-3).map((t) => t.content);
  return tail.join(" ").slice(0, 512);
}

async function loadChunks(
  tenant_id: string,
  connector_id: string | undefined,
  query: string,
  exec: Executor,
): Promise<IncludedChunk[]> {
  if (!connector_id || !query) return [];
  try {
    const hits = await searchDocs({ tenant_id, connector_id, query, limit: 10 }, exec);
    return hits.map((h) => ({
      id: h.id,
      document_id: h.document_id,
      title: h.title,
      path: h.path,
      snippet: h.snippet,
      rank: h.rank,
      tokens: countTokens(h.snippet),
      fetched_at: h.fetched_at,
    }));
  } catch (err) {
    logger.debug({
      module: "llm",
      action: "llm.context.doc_search_skipped",
      msg: "doc search failed during context assembly",
      tenant_id,
      connector_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function loadKnowledgeChunks(
  tenant_id: string,
  workflow_id: string | undefined,
  query: string,
  exec: Executor,
): Promise<IncludedKnowledgeChunk[]> {
  if (!query) return [];
  try {
    const hits = await searchKnowledge(
      { tenant_id, query, ...(workflow_id ? { workflow_id } : {}), limit: 10 },
      exec,
    );
    return hits.map((h) => ({
      id: h.id,
      knowledge_source_id: h.knowledge_source_id,
      title: h.title,
      path: h.path,
      snippet: h.snippet,
      rank: h.rank,
      tokens: countTokens(h.snippet),
      fetched_at: h.fetched_at,
    }));
  } catch (err) {
    logger.debug({
      module: "llm",
      action: "llm.context.knowledge_search_skipped",
      msg: "knowledge search failed during context assembly",
      tenant_id,
      workflow_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface BudgetReport {
  cap_tokens: number;
  total_tokens: number;
  stable_tokens: number;
  volatile_tokens: number;
  messages_tokens: number;
  included: {
    skills: number;
    knowledge: number;
    docs: number;
    failures: number;
  };
  /** Sections dropped by the trimmer, in order. Empty = fit comfortably. */
  dropped_sections: string[];
}

export interface AssembledContext {
  prompt: EnhancedPrompt;
  blocks: CacheBlocks;
  budget_report: BudgetReport;
}

/**
 * Assemble an EnhancedPrompt for the given tenant + flow. Enforces a
 * token budget against the effective model's context cap and drops
 * lowest-priority sections first when the prompt overflows. Throws
 * LlmContextTooLarge only when *even* the base system prompt does not fit
 * — i.e. all optional context has been dropped.
 */
export async function assembleEnhancedPrompt(
  p: AssembleContextParams & { surface?: ConversationSurface },
  exec?: Executor,
): Promise<EnhancedPrompt & { dropped_sections: string[] }> {
  const db = exec ?? getDb();
  const cap = Math.min(p.max_tokens, contextCapFor(p.model ?? "default"));

  const baseSystem = await basePromptFor(p.flow, p.surface, p.authoring_hint);
  const skillsApplicable = await retrieveApplicableSkills(
    {
      tenant_id: p.tenant_id,
      ...(p.connector_id ? { connector_ids: [p.connector_id] } : {}),
      ...(p.workflow_id ? { workflow_ids: [p.workflow_id] } : {}),
    },
    db,
  );

  const globalSkills = skillsApplicable.filter((s) => s.scope === "global");
  const connectorSkills = skillsApplicable.filter((s) => s.scope === "connector");
  const workflowSkills = skillsApplicable.filter((s) => s.scope === "workflow");

  // On-demand skills (load_skill). Each entry is a slug, an id, or a
  // title. Resolution order is slug → id → title — slug first because
  // `loaded_skill_slugs` literally carries slugs from the seed-loader
  // and the auto-loaded authoring constants (loop.ts). Last-resort fetch
  // routes by shape so a bare slug never hits the uuid-typed id column.
  const loadedSkillSlugs = p.loaded_skill_slugs ?? [];
  const loadedSkills = [] as Skill[];
  if (loadedSkillSlugs.length > 0) {
    const existingIds = new Set(skillsApplicable.map((s) => s.id));
    const allTenantSkills = await listSkills({ tenant_id: p.tenant_id }, db);
    for (const ref of loadedSkillSlugs) {
      if (existingIds.has(ref)) continue;
      let match =
        allTenantSkills.find((s) => s.slug === ref) ??
        allTenantSkills.find((s) => s.id === ref) ??
        allTenantSkills.find((s) => s.title.toLowerCase() === ref.toLowerCase());
      if (!match) {
        // Pagination escape hatch: listSkills caps at 500 rows.
        const fetched = UUID_RE.test(ref)
          ? await getSkill(p.tenant_id, ref, db)
          : await getSkillBySlug(p.tenant_id, ref, db);
        if (fetched) match = fetched;
      }
      if (match && !existingIds.has(match.id)) {
        loadedSkills.push(match);
        existingIds.add(match.id);
      }
    }
  }

  const query = buildQuery(p.user_turns);

  // Knowledge + connector-docs embedding is now on-demand for the
  // `converse` flow. The model fetches them via the `search_knowledge`
  // and `fetch_connector_docs` tools only when the turn actually needs
  // them. The one-shot flows (generate / repair / extract / discover /
  // summarize) still pre-embed because they do not have a tool loop to
  // pull context at runtime. Without this split, every trivial read in
  // a conversation paid the full 15 % knowledge + 30 % docs tax
  // regardless of relevance (observed in session 4e6696e3: 1.1 M tokens
  // for a four-row list_workflows).
  const preEmbedCorpus = p.flow !== "converse";
  const knowledgeChunks: IncludedKnowledgeChunk[] = [];
  const chunks: IncludedChunk[] = [];
  if (preEmbedCorpus) {
    const knowledgeBudget = Math.floor(cap * 0.15);
    const rawKnowledgeChunks = await loadKnowledgeChunks(p.tenant_id, p.workflow_id, query, db);
    let knowledgeBytes = 0;
    for (const kc of rawKnowledgeChunks) {
      if (knowledgeBytes + kc.tokens > knowledgeBudget) break;
      knowledgeChunks.push(kc);
      knowledgeBytes += kc.tokens;
    }

    const docsBudget = Math.floor(cap * 0.3);
    const rawChunks = await loadChunks(p.tenant_id, p.connector_id, query, db);
    let docsBytes = 0;
    for (const ch of rawChunks) {
      if (docsBytes + ch.tokens > docsBudget) break;
      chunks.push(ch);
      docsBytes += ch.tokens;
    }
  }

  let failures = p.prior_failures ?? [];
  let userMemory = typeof p.user_memory === "string" ? p.user_memory.trim() : "";
  let authoringContext = typeof p.authoring_context === "string" ? p.authoring_context.trim() : "";

  // Interaction log — last N resolved elicitations for this
  // conversation. Only loaded for the converse flow (one-shot flows
  // don't have an interactive history to reference) and only when the
  // caller threaded a conversation_id through. The trimmer treats
  // this section the same as prior_failures: dropped early under
  // pressure, but cheap when the budget allows.
  let interactionLogEntries: InteractionLogEntry[] = [];
  if (p.flow === "converse" && p.conversation_id) {
    interactionLogEntries = await loadInteractionLog(p.tenant_id, p.conversation_id, db);
  }

  // Latest preview — compact per-step shape from the most recent
  // dry_run / run on this conversation. Reads
  // `conversations.draft.latest_preview.step_traces`; if no preview
  // has been recorded the section is empty and trim is a no-op. Only
  // for the converse flow, same as interaction_log.
  let latestPreviewEntries: LatestPreviewEntry[] = [];
  if (p.flow === "converse" && p.conversation_id) {
    latestPreviewEntries = await loadLatestPreview(p.tenant_id, p.conversation_id, db);
  }

  // Operator quirks for the in-scope connector. Loaded once per
  // assembly; the picker `selectOperatorQuirkCategories` reads the
  // structured authoring hint to render only the categories relevant
  // to the current turn shape. Per-category cap is 2 KB so even all
  // six rendered together is bounded; per-turn selection typically
  // drops 40-90% of the volume vs the legacy `operator_notes` blob.
  //
  // Recipe surfacing: when the connector was created from a template
  // that ships executable recipes, the template snapshot carries a
  // `recipes` array. We surface a slim summary (slug + title +
  // intent_keywords — never the workflow body) so the LLM can offer
  // `start_workflow_from_recipe(slug)` instead of authoring from
  // scratch on the next turn.
  let connectorOperatorQuirksBlock: string | null = null;
  let connectorRecipesBlock: string | null = null;
  if (p.connector_id) {
    try {
      const connector = await getConnector(p.tenant_id, p.connector_id, db);
      const quirks = connector?.operator_quirks ?? {};
      const categories = selectOperatorQuirkCategories(
        p.authoring_hint,
        (failures?.length ?? 0) > 0,
      );
      if (connector && Object.keys(quirks).length > 0) {
        connectorOperatorQuirksBlock = formatOperatorQuirks(
          connector.slug,
          connector.display_name,
          quirks,
          categories,
        );
      }
      if (connector?.template_snapshot) {
        connectorRecipesBlock = formatConnectorRecipes(
          connector.slug,
          connector.template_snapshot as Record<string, unknown>,
        );
      }
    } catch (err) {
      logger.debug({
        module: "llm",
        action: "llm.context.operator_quirks_skipped",
        msg: "operator_quirks load failed during context assembly",
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const runtimeBlock = p.runtime_context
    ? renderRuntimeContextBlock({
        ...(p.runtime_context.engine_url ? { engine_url: p.runtime_context.engine_url } : {}),
        ...(p.runtime_context.tenant_slug ? { tenant_slug: p.runtime_context.tenant_slug } : {}),
        ...(p.runtime_context.actor_email ? { actor_email: p.runtime_context.actor_email } : {}),
        ...(p.runtime_context.actor_role ? { actor_role: p.runtime_context.actor_role } : {}),
        ...(p.runtime_context.surface ? { surface: p.runtime_context.surface } : {}),
      })
    : null;

  // Tenant snapshot block — concise list of workflows + connectors so
  // the model can answer "what do I have?" without round-tripping via
  // list_* tools. Only for the converse flow; one-shot flows do not
  // need it.
  const tenantSummaryBlock =
    p.flow === "converse"
      ? renderTenantSummaryBlock(await loadTenantSummary(p.tenant_id, db))
      : null;

  const render = () => {
    const sections: string[] = [];
    // Tenant snapshot appears at BOTH ends of the stable head:
    //   1) immediately before the base prompt so the model reads it
    //      first on the initial pass, and
    //   2) again at the tail (just before the volatile segment) so it
    //      is the most recent context before the user turn.
    // The duplication costs a few hundred tokens but reliably beats
    // the 85k-of-skills wall where a mid-prompt snapshot gets ignored.
    if (tenantSummaryBlock) sections.push(tenantSummaryBlock);
    sections.push(baseSystem);
    if (runtimeBlock) sections.push(runtimeBlock);
    // Ambient skills render as a single per-scope INDEX block — one
    // line per skill (slug + title + first-line description). The
    // LLM uses `load_skill(<slug>)` to pull the full body when it
    // actually needs the rules (which moves the skill into
    // `loadedSkills` for subsequent turns). The index is bounded by
    // skill count and stays cache-friendly across turns; per-skill
    // summary blocks were ~58 tokens each, scaling unboundedly with
    // skill body first-line size.
    const globalIndexBlock = formatSkillIndex("Global", globalSkills, p.runtime_context);
    const connectorIndexBlock = formatSkillIndex("Connector", connectorSkills, p.runtime_context);
    const workflowIndexBlock = formatSkillIndex("Workflow", workflowSkills, p.runtime_context);
    if (globalIndexBlock) sections.push(globalIndexBlock);
    if (connectorOperatorQuirksBlock) sections.push(connectorOperatorQuirksBlock);
    if (connectorRecipesBlock) sections.push(connectorRecipesBlock);
    if (connectorIndexBlock) sections.push(connectorIndexBlock);
    if (workflowIndexBlock) sections.push(workflowIndexBlock);
    // Loaded skills carry the full body — the LLM explicitly opted
    // in via load_skill, so the cost is justified.
    for (const s of loadedSkills) sections.push(formatSkill(s, p.runtime_context));
    for (const kc of knowledgeChunks) sections.push(formatKnowledgeChunk(kc));
    if (userMemory) sections.push(formatUserMemory(userMemory));
    for (const c of chunks) sections.push(formatChunk(c));
    if (latestPreviewEntries.length > 0) {
      sections.push(formatLatestPreview(latestPreviewEntries));
    }
    if (interactionLogEntries.length > 0) {
      sections.push(formatInteractionLog(interactionLogEntries));
    }
    for (const f of failures) sections.push(formatFailure(f));
    if (tenantSummaryBlock) sections.push(tenantSummaryBlock);
    // Authoring context lives at the very tail so it stays in the
    // volatile cache segment — it changes every turn and must not
    // invalidate the stable prefix above.
    if (authoringContext) sections.push(authoringContext);
    return sections.join("\n\n");
  };

  let system = render();
  let systemTokens = countTokens(system);
  const messagesTokens = countMessagesTokens(p.user_turns);
  let total = systemTokens + messagesTokens;

  // Drop order (lowest priority dropped first):
  //   failures → connector docs → knowledge chunks → user memory →
  //   authoring context → explicitly loaded skills → workflow skills →
  //   connector skills → global skills.
  const recount = () => {
    system = render();
    systemTokens = countTokens(system);
    total = systemTokens + messagesTokens;
  };

  const trimmed: string[] = [];
  // Skill-body summary used as a fallback when we'd otherwise pop a
  // whole skill. Keeps the skill name + scope visible to the model
  // (so it can call `load_skill` to re-fetch the full body) while
  // shedding the bulk of the markdown body. Saves ~70-90% per skill
  // vs. dropping it entirely. Pre-fix the trim path popped the whole
  // skill record, removing the title + scope hint from the model's
  // context — losing the SIGNAL that the skill exists at all.
  // 100-char summary keeps the title + first sentence visible (enough
  // for the model to decide whether to call `load_skill`) without
  // bloating the trimmed prompt. Lower than the original 200 so a
  // 5-skill global bundle costs ~250 tokens after trim instead of ~500.
  const SKILL_BODY_SUMMARY_LIMIT = 100;
  const trimSkill = (s: import("../../skills/types.ts").Skill): typeof s => {
    if (s.body.length <= SKILL_BODY_SUMMARY_LIMIT) return s;
    return {
      ...s,
      body: `${s.body.slice(0, SKILL_BODY_SUMMARY_LIMIT).trim()}… [load_skill('${s.title ?? s.id}') for full body]`,
    };
  };
  // Loaded skills go through a progressive body-trim before being
  // popped. Ambient (index-form) skills can't be partially trimmed —
  // their block is dropped wholesale once the budget runs out.
  let trimmedLoadedCursor = 0;
  while (total > cap) {
    if (interactionLogEntries.length > 0) {
      // Drop interaction log first — same priority as failures (both
      // are "recent conversation context" rather than load-bearing
      // domain knowledge). The model can still see the recent tool
      // calls in the message history; the log is a convenience.
      interactionLogEntries = [];
      trimmed.push("interaction_log");
    } else if (failures.length > 0) {
      failures = [];
      trimmed.push("failures");
    } else if (chunks.length > 0) {
      chunks.pop();
      trimmed.push("docs");
    } else if (latestPreviewEntries.length > 0) {
      // Drop latest_preview before knowledge chunks: when the budget
      // is this tight the model needs domain knowledge to recover,
      // and the preview is recoverable on the next turn via
      // dry_run_workflow / suggest_jsonata_paths.
      latestPreviewEntries = [];
      trimmed.push("latest_preview");
    } else if (knowledgeChunks.length > 0) {
      knowledgeChunks.pop();
      trimmed.push("knowledge");
    } else if (userMemory) {
      userMemory = "";
      trimmed.push("user_memory");
    } else if (authoringContext) {
      authoringContext = "";
      trimmed.push("authoring_context");
    } else if (loadedSkills.length > 0 && trimmedLoadedCursor < loadedSkills.length) {
      const idx = trimmedLoadedCursor++;
      const cur = loadedSkills[idx];
      if (cur && cur.body.length > SKILL_BODY_SUMMARY_LIMIT) {
        loadedSkills[idx] = trimSkill(cur);
        trimmed.push("loaded_skill_body_trimmed");
      }
    } else if (loadedSkills.length > 0) {
      loadedSkills.pop();
      trimmed.push("loaded_skill");
    } else if (workflowSkills.length > 0) {
      // Index blocks render as one section per scope. Dropping them
      // entirely is the right granularity — we can't pop one entry
      // without re-rendering the block. Workflow scope drops first
      // because the model can re-discover workflow-bound skills via
      // load_skill once the conversation has a target_workflow_id.
      workflowSkills.length = 0;
      trimmed.push("workflow_skill_index");
    } else if (connectorSkills.length > 0) {
      connectorSkills.length = 0;
      trimmed.push("connector_skill_index");
    } else if (connectorRecipesBlock) {
      // Recipes are a navigation aid — dropping them just means the
      // LLM falls back to authoring from scratch. Trim before quirks
      // (which are operator-authored, more authoritative).
      connectorRecipesBlock = null;
      trimmed.push("connector_recipes");
    } else if (connectorOperatorQuirksBlock) {
      // operator_quirks is the operator's direct, imperative instruction
      // for this connector — drop it only when nothing else remains
      // except global skills and the base prompt.
      connectorOperatorQuirksBlock = null;
      trimmed.push("connector_operator_quirks");
    } else if (globalSkills.length > 0) {
      globalSkills.length = 0;
      trimmed.push("global_skill_index");
    } else {
      logger.error({
        module: "llm",
        action: "context.overflow",
        msg: "prompt exceeds model context window after trimming",
        tenant_id: p.tenant_id,
        flow: p.flow,
        model: p.model ?? null,
        total,
        cap,
        trimmed,
      });
      throw new LlmContextTooLarge("prompt exceeds model context window after trimming", {
        total,
        cap,
      });
    }
    recount();
  }

  if (trimmed.length > 0) {
    logger.warn({
      module: "llm",
      action: "context.trimmed",
      msg: "context assembly dropped sections to fit model cap",
      tenant_id: p.tenant_id,
      flow: p.flow,
      model: p.model ?? null,
      cap,
      total_after: total,
      dropped: trimmed,
    });
  }

  const includedSkills = [...globalSkills, ...connectorSkills, ...workflowSkills, ...loadedSkills];
  return {
    system,
    messages: p.user_turns,
    token_counts: {
      system: systemTokens,
      skills: includedSkills.reduce(
        (t, s) => t + countTokens(formatSkill(s, p.runtime_context)),
        0,
      ),
      knowledge: knowledgeChunks.reduce((t, kc) => t + kc.tokens, 0),
      docs: chunks.reduce((t, c) => t + c.tokens, 0),
      failures: failures.reduce((t, f) => t + countTokens(formatFailure(f)), 0),
      messages: messagesTokens,
      total,
    },
    included_skill_ids: includedSkills.map((s) => s.id),
    included_chunk_ids: chunks.map((c) => c.id),
    included_knowledge_chunk_ids: knowledgeChunks.map((kc) => kc.id),
    included_skills: includedSkills,
    included_chunks: chunks,
    included_knowledge_chunks: knowledgeChunks,
    dropped_sections: trimmed,
  };
}

/**
 * Detect which auto-load skills match the current conversation context.
 * Matching is deterministic: checks attachment MIME types and message
 * keywords against skill `trigger_keywords`. No LLM call.
 *
 * Returns skill slugs (ids or titles) to append to `loaded_skill_slugs`.
 */
export async function detectIntentSkills(
  tenant_id: string,
  opts: {
    attachmentMimeTypes?: string[];
    userMessage?: string;
    hasFailedExecution?: boolean;
    hasMultipleConnectors?: boolean;
  },
  exec?: Executor,
): Promise<string[]> {
  const keywords: string[] = [];

  for (const mime of opts.attachmentMimeTypes ?? []) {
    const lower = mime.toLowerCase();
    if (lower.includes("openapi") || lower.includes("yaml") || lower.includes("json")) {
      keywords.push("openapi", "swagger", "yaml", "json");
    }
    if (lower === "application/pdf" || lower.includes("pdf")) keywords.push("pdf");
    if (lower.startsWith("image/")) keywords.push("image", "screenshot", "png", "jpg");
    if (lower.includes("postman")) keywords.push("postman");
    if (lower.includes("graphql") || lower.includes("gql")) keywords.push("graphql");
    if (lower.includes("har")) keywords.push("har");
  }

  const msg = (opts.userMessage ?? "").toLowerCase();
  if (msg.includes("openapi") || msg.includes("swagger")) keywords.push("openapi");
  if (msg.includes("postman")) keywords.push("postman");
  if (msg.includes("graphql")) keywords.push("graphql");
  // External MCP-client integration intents — any MCP-aware client
  // (Codex, Claude Code, Claude Desktop, Cursor, Continue, Zed, Goose,
  // …). Loads the generic `mcp-server-setup` Skill; vendor-specific
  // config shapes live in the VendorRecipeManifest and are fetched
  // per-client via the `get_vendor_recipe` tool, not baked into prose.
  if (
    msg.includes("mcp") ||
    msg.includes("codex") ||
    msg.includes("claude code") ||
    msg.includes("claude desktop") ||
    msg.includes("cursor") ||
    msg.includes("continue") ||
    msg.includes("zed") ||
    msg.includes("goose")
  ) {
    keywords.push(
      "mcp",
      "mcp server",
      "mcp client",
      "model context protocol",
      "codex",
      "claude code",
      "claude desktop",
      "cursor",
      "continue",
      "zed",
      "goose",
    );
  }
  // Connector-creation intent. The `connector-creation-guidance` skill
  // was deliberately narrowed from a broad "api/http/endpoint" trigger
  // to creation-intent phrases only, so we match those phrases here.
  // Mentioning `create connector` / `new connector` pushes the checklist
  // skill; a user talking about an *existing* connector (or authoring
  // against one) does not pay the context cost.
  if (
    msg.includes("create connector") ||
    msg.includes("new connector") ||
    msg.includes("add connector") ||
    msg.includes("create a connector") ||
    msg.includes("add a connector") ||
    msg.includes("create integration") ||
    msg.includes("new integration") ||
    msg.includes("add integration") ||
    msg.includes("set up integration") ||
    msg.includes("configure connector") ||
    msg.includes("start connector")
  ) {
    keywords.push(
      "create connector",
      "new connector",
      "add connector",
      "add integration",
      "new integration",
      "set up integration",
      "configure connector",
      "start connector",
      "start_connector_from_description",
      "start_connector_from_template",
    );
  }
  // Execution-time failure diagnosis keywords — matches
  // `troubleshooting-workflow-failures.md`'s triggers. Pushed when the
  // loop's hasFailedExecution flag is set OR the user's message refers
  // to a past run.
  if (
    opts.hasFailedExecution ||
    msg.includes("execution failed") ||
    msg.includes("run failed") ||
    msg.includes("workflow failed") ||
    msg.includes("past run") ||
    msg.includes("circuit open") ||
    msg.includes("schema_violation") ||
    msg.includes("schema-violation")
  ) {
    keywords.push(
      "troubleshoot",
      "execution failed",
      "run failed",
      "workflow failed",
      "past run",
      "schema-violation",
      "circuit-breaker",
    );
  }
  // Authoring-time tool-error keywords — matches `error-recovery.md`'s
  // triggers. Pushed on explicit error shapes a user might paste OR the
  // model referencing its own failed tool call.
  if (
    msg.includes("error") ||
    msg.includes("failed") ||
    msg.includes("4xx") ||
    msg.includes("5xx") ||
    msg.includes("placeholder_unresolved") ||
    msg.includes("permission_denied") ||
    msg.includes("validation_failed") ||
    msg.includes("step_timeout") ||
    msg.includes("connector_not_found")
  ) {
    keywords.push(
      "error",
      "failed",
      "http_4xx",
      "http_5xx",
      "placeholder_unresolved",
      "permission_denied",
      "validation_failed",
      "step_timeout",
      "connector_not_found",
      "tool error",
    );
  }
  if (opts.hasMultipleConnectors) keywords.push("multi-connector", "orchestration");
  if (keywords.length === 0) keywords.push("onboarding");

  const matched = await listAutoLoadSkills(tenant_id, [...new Set(keywords)], exec);
  return matched.map((s) => s.id);
}

/**
 * High-level entry point — wraps `assembleEnhancedPrompt` with the
 * stable/volatile cache-block split and a structured `BudgetReport`.
 * `core/invoke.ts` uses this before dispatching to the AiSdkModel.
 */
export async function assembleContext(
  params: AssembleContextParams,
  exec?: Executor,
): Promise<AssembledContext> {
  const prompt = await assembleEnhancedPrompt(params, exec);
  const blocks = splitPromptIntoBlocks(prompt, params.flow);
  const effectiveCap = Math.min(params.max_tokens, contextCapFor(params.model ?? "default"));
  const includedFailureCount = prompt.dropped_sections.includes("failures")
    ? 0
    : (params.prior_failures ?? []).length;

  const { dropped_sections, ...promptWithoutDropped } = prompt;

  const budget_report = {
    cap_tokens: effectiveCap,
    total_tokens: prompt.token_counts.total,
    stable_tokens: blocks.token_counts.stable,
    volatile_tokens: blocks.token_counts.volatile,
    messages_tokens: prompt.token_counts.messages,
    included: {
      skills: prompt.included_skill_ids.length,
      knowledge: prompt.included_knowledge_chunk_ids.length,
      docs: prompt.included_chunk_ids.length,
      failures: includedFailureCount,
    },
    dropped_sections,
  };

  // Surface every assembly as a structured event. The metric and the
  // log line let operators see at a glance which flows are running
  // hot, which sections are getting trimmed, and how much of the
  // available cap is being spent.
  recordLlmContextAssembled({
    tenant_id: params.tenant_id,
    flow: params.flow,
    model: params.model ?? "default",
    cap_tokens: budget_report.cap_tokens,
    total_tokens: budget_report.total_tokens,
    stable_tokens: budget_report.stable_tokens,
    volatile_tokens: budget_report.volatile_tokens,
    messages_tokens: budget_report.messages_tokens,
    included: budget_report.included,
    dropped_sections: budget_report.dropped_sections,
  });

  return {
    prompt: promptWithoutDropped,
    blocks,
    budget_report,
  };
}
