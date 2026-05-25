// DB-side loaders for the context assembler. Each helper is best-
// effort: a DB blip never blocks prompt assembly — the caller gets an
// empty array and the assembled prompt simply omits the section.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { conversationElicitations, conversations } from "../../../db/schema/index.ts";
import { searchDocs } from "../../../docs-ingestion/service.ts";
import { searchKnowledge } from "../../../knowledge/service.ts";
import { logger } from "../../../logging/logger.ts";
import { listProposedForAuthoring } from "../../../skill-candidates/service.ts";
import type { SkillCandidateView } from "../../../skill-candidates/types.ts";
import { countTokens } from "../../accounting/index.ts";
import type {
  AuthoringPromptHint,
  IncludedChunk,
  IncludedKnowledgeChunk,
  UserTurn,
} from "../../types.ts";
import {
  _recipeBodiesSectionCapForTrim,
  _recipeBodyHybridSoftCap,
  _skillCandidatesSectionCapForTrim,
  formatConnectorRecipeBodies,
  formatSkillCandidates,
  type RecipeBodyView,
  renderRecipeBody,
} from "./formatters.ts";

export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface InteractionLogEntry {
  tool_name: string;
  status: string;
  decision: string;
  /**
   * The operator's free-text feedback, projected from `output.feedback`.
   * A previous review pass moved operator prose off `decision_reason`
   * (which now carries only a machine code) onto the elicitation
   * `output`. Prefer this when rendering; fall back to `decision_reason`.
   */
  feedback: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
}

/** Compact preview entry surfaced to the model. */
export interface LatestPreviewEntry {
  step_id: string;
  kind: string;
  status: string;
  shape_summary?: string;
  primary_data_path?: string | null;
  available_paths?: string[];
  error_code?: string;
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
export async function loadInteractionLog(
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
      // Operator free text now rides on `output.feedback` — a previous
      // review pass moved it off `decision_reason` (which keeps only a
      // machine code). Project it so `formatInteractionLog` can prefer
      // the human prose over the stable token.
      const feedback =
        typeof output?.feedback === "string" && output.feedback.length > 0 ? output.feedback : null;
      return {
        tool_name: r.tool_name,
        status: r.status,
        decision,
        feedback,
        decision_reason: r.decision_reason,
        decided_at: r.decided_at,
      };
    });
  } catch (err) {
    logger.warn({
      module: "llm",
      action: "llm.context.interaction_log_skipped",
      msg: "interaction log query failed; prompt assembled without it",
      tenant_id,
      conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Read the most recent dry-run / run preview off the conversation's
 * persisted draft (`conversations.draft.latest_preview.step_traces`).
 * Compacted to step_id + kind + status + scope_at_step. The
 * authoring loop will reach for this before guessing a JSONata path
 * — no need to re-issue a dry_run just to remember the shape.
 */
export async function loadLatestPreview(
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
  } catch (err) {
    logger.warn({
      module: "llm",
      action: "llm.context.latest_preview_skipped",
      msg: "latest-preview query failed; prompt assembled without it",
      tenant_id,
      conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function loadChunks(
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

export async function loadKnowledgeChunks(
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

// ---------------------------------------------------------------------------
// Recipe bodies + Skill candidates — R5 loop closure
// ---------------------------------------------------------------------------

/** Normalise a token for case-folded, punctuation-stripped comparison.
 *  Local helper because the existing keyword normaliser in
 *  `connector-template-intelligence` lowercases but keeps punctuation —
 *  the ranking score needs aggressive normalisation to match operator-typed
 *  intent like "list customers!" against a `list-customers` keyword. */
function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Tokenise free text for the score function. Filters empty tokens. */
function tokenizeForRanking(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
}

/** Build the ranking query string from the authoring hint + the tail of
 *  the user turns. Pure — mirrors `buildQuery` in context-assembler.ts
 *  but adds the structured hint fields so recipes are surfaced based on
 *  the explicit "next action" signal too. */
export function buildRecipeRankingQuery(
  hint: AuthoringPromptHint | undefined,
  turns: UserTurn[],
): string {
  const parts: string[] = [];
  if (hint?.next_required_action) parts.push(hint.next_required_action);
  if (hint?.active_target?.kind) parts.push(hint.active_target.kind);
  for (const turn of turns.slice(-3)) parts.push(turn.content);
  return parts.join(" ").slice(0, 512);
}

/**
 * Pure ranker over the snapshot's recipes list. Returns the top `max`
 * `RecipeBodyView`s, deterministically (slug asc for ties). The snapshot
 * is the connector's `template_snapshot` already fetched by the
 * assembler — no second `getConnector` round-trip.
 *
 * Defensive against missing fields. Recipes without `slug`, `title`, or
 * `workflow` are skipped — not a hard error. Returns `[]` when the
 * snapshot ships no recipes (or is malformed).
 */
export function loadTopRecipeBodies(
  snapshot: Record<string, unknown> | null | undefined,
  authoringHint: AuthoringPromptHint | undefined,
  query: string,
  max = 3,
): RecipeBodyView[] {
  if (!snapshot) return [];
  const raw = snapshot.recipes;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const templateSlug = typeof snapshot.slug === "string" ? snapshot.slug : "unknown";
  const fullQuery = `${authoringHint?.next_required_action ?? ""} ${
    authoringHint?.active_target?.kind ?? ""
  } ${query}`;
  const queryTokens = new Set(tokenizeForRanking(fullQuery));

  interface Scored {
    score: number;
    view: RecipeBodyView;
  }
  const scored: Scored[] = [];

  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const slug = typeof rec.slug === "string" ? rec.slug : null;
    const title = typeof rec.title === "string" ? rec.title : null;
    const workflow = rec.workflow;
    if (!slug || !title || workflow === undefined || workflow === null) continue;

    const description = typeof rec.description === "string" ? rec.description : "";
    const prerequisites = Array.isArray(rec.prerequisites)
      ? (rec.prerequisites as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    const required_connectors = Array.isArray(rec.required_connectors)
      ? (rec.required_connectors as unknown[])
          .filter(
            (rc): rc is { placeholder: string; template: string } =>
              !!rc &&
              typeof rc === "object" &&
              typeof (rc as { placeholder?: unknown }).placeholder === "string" &&
              typeof (rc as { template?: unknown }).template === "string",
          )
          .map((rc) => ({ placeholder: rc.placeholder, template: rc.template }))
      : [];
    const intent_keywords = Array.isArray(rec.intent_keywords)
      ? (rec.intent_keywords as unknown[]).filter((k): k is string => typeof k === "string")
      : [];
    const tags = Array.isArray(rec.tags)
      ? (rec.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const sample_input = rec.sample_input ?? null;

    const kwTokens = intent_keywords.map(normalizeToken);
    const tagTokens = tags.map(normalizeToken);
    const titleTokens = tokenizeForRanking(title);
    const descTokens = tokenizeForRanking(description);

    const inter = (xs: string[]): number => xs.filter((t) => queryTokens.has(t)).length;
    const score =
      3 * inter(kwTokens) + 2 * inter(tagTokens) + 1 * inter(titleTokens) + 1 * inter(descTokens);

    scored.push({
      score,
      view: {
        template_slug: templateSlug,
        recipe_slug: slug,
        title,
        description,
        prerequisites,
        required_connectors,
        sample_input,
        workflow,
      },
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.view.recipe_slug.localeCompare(b.view.recipe_slug);
  });

  return scored.slice(0, max).map((s) => s.view);
}

/**
 * Render-and-count trim: drop the lowest-ranked recipe bodies one at a
 * time until the formatter's section string fits the cap. `bodies` is
 * already in rank order (highest first); we pop from the tail. Bounded:
 * at most N iterations where N ≤ `max` from `loadTopRecipeBodies`.
 *
 * The trim helpers MUST call the formatter on each iteration — the cap
 * applies to the final rendered section string (heading + per-item
 * bodies + fences), not raw per-body tokens (risk callout #4).
 *
 * Returns the surviving list and the rendered section (or null if
 * everything was dropped). When at least one body was trimmed, an
 * elision notice is appended to the section.
 */
export function trimRecipeBodiesToBudget(
  templateSlug: string,
  bodies: RecipeBodyView[],
): { survivors: RecipeBodyView[]; section: string | null; trimmed: number } {
  if (bodies.length === 0) return { survivors: [], section: null, trimmed: 0 };
  const cap = _recipeBodiesSectionCapForTrim;
  const survivors = [...bodies];
  let trimmed = 0;

  // Render-and-count: try the full set first, pop the lowest-ranked
  // body if it overflows, repeat until fit or empty.
  while (survivors.length > 0) {
    const sectionBase = formatConnectorRecipeBodies(templateSlug, survivors);
    if (sectionBase === null) break;
    const notice =
      trimmed > 0
        ? `\n\n_${trimmed} more recipe body${trimmed === 1 ? "" : "ies"} elided — token budget_`
        : "";
    const candidate = `${sectionBase}${notice}`;
    if (countTokens(candidate) <= cap) {
      return { survivors, section: candidate, trimmed };
    }
    survivors.pop();
    trimmed += 1;
  }
  return { survivors: [], section: null, trimmed };
}

/** Emit the R1 fallback warning log for each surviving recipe whose
 *  body rendered via the hybrid path (workflow JSON elided). Called by
 *  the assembler exactly once per assembly, after the trim loop decides
 *  the final set — so a render-and-count trim never emits a duplicate
 *  warning. */
export function logRecipeBodyFallbacks(
  templateSlug: string,
  tenant_id: string,
  bodies: RecipeBodyView[],
): void {
  for (const body of bodies) {
    const r = renderRecipeBody(body);
    if (!r.fellBack) continue;
    logger.warn({
      module: "llm",
      action: "llm.context.recipe_body_fallback",
      msg: "recipe body exceeded soft cap; rendered hybrid payload without workflow JSON",
      tenant_id,
      template_slug: templateSlug,
      recipe_slug: body.recipe_slug,
      body_tokens: countTokens(JSON.stringify(body.workflow)),
      soft_cap_tokens: _recipeBodyHybridSoftCap,
    });
  }
}

/**
 * Load the top proposed Skill Candidates for the LLM context.
 * Best-effort: returns `[]` on any DB error so the assembler keeps
 * working. Scope hints from the assembler — global + maybe-connector +
 * maybe-workflow. Service-level merge / rank / cap (=8) happens inside
 * `listProposedForAuthoring`.
 *
 * Wired into the assembler in commit 3 (skill-candidates section). Lives
 * in this commit so the loaders/formatters pair compiles as one slice;
 * importing `listProposedForAuthoring` validates the index.ts export
 * (added in this commit — see PR body).
 */
export async function loadProposedCandidates(
  tenant_id: string,
  scope_hints: { connector_id?: string | undefined; workflow_id?: string | undefined },
  exec: Executor,
): Promise<SkillCandidateView[]> {
  try {
    // Strip explicit undefineds so the service signature (which uses
    // optional-but-not-undefinable fields under exactOptionalPropertyTypes)
    // accepts the call cleanly.
    const hints: { connector_id?: string; workflow_id?: string } = {};
    if (scope_hints.connector_id) hints.connector_id = scope_hints.connector_id;
    if (scope_hints.workflow_id) hints.workflow_id = scope_hints.workflow_id;
    return await listProposedForAuthoring(tenant_id, hints, exec);
  } catch (err) {
    logger.debug({
      module: "llm",
      action: "llm.context.proposed_candidates_skipped",
      msg: "proposed-candidate load failed during context assembly",
      tenant_id,
      ...(scope_hints.connector_id ? { connector_id: scope_hints.connector_id } : {}),
      ...(scope_hints.workflow_id ? { workflow_id: scope_hints.workflow_id } : {}),
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Render-and-count trim for the skill-candidates section. Mirrors
 * `trimRecipeBodiesToBudget`. When the loop terminates with a single
 * over-cap survivor, the body is truncated to ceil(cap_tokens * 0.9)
 * re-counted tokens and the `llm.context.section_oversized_item` warning
 * is wired in commit 3 when the loader is called from the assembler.
 */
export function trimCandidatesToBudget(candidates: SkillCandidateView[]): {
  survivors: SkillCandidateView[];
  section: string | null;
  trimmed: number;
  oversized_item_id: string | null;
} {
  if (candidates.length === 0) {
    return { survivors: [], section: null, trimmed: 0, oversized_item_id: null };
  }
  const cap = _skillCandidatesSectionCapForTrim;
  const survivors = [...candidates];
  let trimmed = 0;

  while (survivors.length > 0) {
    const sectionBase = formatSkillCandidates(survivors);
    if (sectionBase === null) break;
    const notice =
      trimmed > 0
        ? `\n\n_${trimmed} more candidate${trimmed === 1 ? "" : "s"} elided — token budget_`
        : "";
    const candidate = `${sectionBase}${notice}`;
    if (countTokens(candidate) <= cap) {
      return { survivors, section: candidate, trimmed, oversized_item_id: null };
    }
    // R6 (oversized single body): one survivor left and still over cap.
    // Truncate the body to ≤ ceil(cap * 0.9) re-counted tokens via a
    // bounded binary search (~15 iterations max). The 0.9 leaves
    // headroom for the section heading + meta + truncation notice.
    if (survivors.length === 1) {
      const only = survivors[0];
      if (!only) break;
      const targetTokens = Math.ceil(cap * 0.9);
      let lo = 0;
      let hi = only.body.length;
      let bestBody = "";
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        const slice = `${only.body.slice(0, mid)}\n\n_… candidate body truncated for section cap_`;
        const probe = formatSkillCandidates([{ ...only, body: slice }]);
        if (probe !== null && countTokens(probe) <= targetTokens) {
          bestBody = slice;
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      survivors[0] = { ...only, body: bestBody };
      const finalSection = formatSkillCandidates(survivors);
      return { survivors, section: finalSection, trimmed, oversized_item_id: only.id };
    }
    survivors.pop();
    trimmed += 1;
  }
  return { survivors: [], section: null, trimmed, oversized_item_id: null };
}
