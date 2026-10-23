import { and, desc, eq } from "drizzle-orm";
import { readDiscoveryIndexForBaseUrl } from "../../../connectors/discovery/service.ts";
import type { ConnectorSelfDescription } from "../../../connectors/types.ts";
import type { Executor } from "../../../db/client.ts";
import { connectors, conversationElicitations, conversations } from "../../../db/schema/index.ts";
import { searchDocs } from "../../../docs-ingestion/service.ts";
import { searchKnowledge } from "../../../knowledge/service.ts";
import { DOMAIN_TAG_PREFIX } from "../../../knowledge/tags.ts";
import { logger } from "../../../logging/logger.ts";
import { getMetrics, METRIC_NAMES } from "../../../observability/metrics.ts";
import { listLatestShapes } from "../../../schema-versions/service.ts";
import { listProposedForAuthoring } from "../../../skill-candidates/service.ts";
import type { SkillCandidateView } from "../../../skill-candidates/types.ts";
import { findSimilarActive, type PriorWorkflowRef } from "../../../workflows/prior-workflows.ts";
import { countTokens } from "../../accounting/index.ts";
import type {
  AuthoringPromptHint,
  IncludedChunk,
  IncludedKnowledgeChunk,
  UserTurn,
} from "../../types.ts";
import {
  formatConnectorSchemaSummaries,
  formatProbeShapeExamples,
  formatSkillCandidates,
  PRIOR_WORKFLOWS_TOP_K,
  PROBE_SHAPE_MAX_CONNECTORS,
  PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR,
  type ProbeShapeExample,
  RECIPE_BODIES_SECTION_CAP,
  RECIPE_BODIES_TOP_K,
  RECIPE_BODY_HYBRID_SOFT_CAP,
  type RecipeBodyView,
  renderRecipeBody,
  SKILL_CANDIDATES_SECTION_CAP,
} from "./formatters.ts";

export async function loadConnectorAuthoringAids(
  p: {
    flow: string;
    tenant_id: string;
    authoring_hint?: { mode?: string } | null;
    authoring_connector_ids?: string[];
  },
  exec: Executor,
): Promise<{ probeShapeExamplesBlock: string | null; connectorSchemaBlock: string | null }> {
  if (
    p.flow !== "converse" ||
    p.authoring_hint?.mode !== "workflow" ||
    !p.authoring_connector_ids ||
    p.authoring_connector_ids.length === 0
  ) {
    return { probeShapeExamplesBlock: null, connectorSchemaBlock: null };
  }
  const [shapeExamples, schemaSummaries] = await Promise.all([
    loadProbeShapeExamples(p.tenant_id, p.authoring_connector_ids, exec),
    loadConnectorSchemaSummaries(p.tenant_id, p.authoring_connector_ids, exec),
  ]);
  logger.info({
    module: "llm",
    action: "context.connector_authoring_aids",
    tenant_id: p.tenant_id,
    connector_ids: p.authoring_connector_ids.length,
    schema_summaries: schemaSummaries.length,
    self_descriptions: schemaSummaries.filter((s) => s.self_description_line).length,
    probe_shapes: shapeExamples.length,
  });
  return {
    probeShapeExamplesBlock:
      shapeExamples.length > 0 ? formatProbeShapeExamples(shapeExamples) : null,
    connectorSchemaBlock:
      schemaSummaries.length > 0 ? formatConnectorSchemaSummaries(schemaSummaries) : null,
  };
}

export interface InteractionLogEntry {
  tool_name: string;
  status: string;
  decision: string;
  feedback: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
}

export interface LatestPreviewEntry {
  step_id: string;
  kind: string;
  status: string;
  shape_summary?: string;
  primary_data_path?: string | null;
  available_paths?: string[];
  error_code?: string;
}

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadProbeShapeExamples(
  tenant_id: string,
  connector_ids: string[],
  exec: Executor,
): Promise<ProbeShapeExample[]> {
  try {
    const ids = [...new Set(connector_ids)]
      .filter((id) => UUID_RE.test(id))
      .slice(0, PROBE_SHAPE_MAX_CONNECTORS);
    if (ids.length === 0) return [];
    const out: ProbeShapeExample[] = [];
    for (const connector_id of ids) {
      const shapes = await listLatestShapes(
        { tenant_id, connector_id, max_endpoints: PROBE_SHAPE_MAX_ENDPOINTS_PER_CONNECTOR },
        exec,
      );
      if (shapes.length === 0) continue;
      const connectorRows = await exec
        .select({ slug: connectors.slug })
        .from(connectors)
        .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, connector_id)))
        .limit(1);
      const slug = connectorRows[0]?.slug;
      if (!slug) continue;
      for (const s of shapes) {
        out.push({ connector_slug: slug, endpoint_key: s.endpoint_key, shape: s.shape });
      }
    }
    return out;
  } catch (err) {
    logger.warn({
      module: "llm",
      action: "llm.context.probe_shapes_skipped",
      msg: "recorded endpoint shapes query failed; prompt assembled without them",
      tenant_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface ConnectorSchemaSummary {
  connector_slug: string;
  operations: string[];
  self_description_line?: string;
}

export function buildSelfDescriptionLine(
  self_description: ConnectorSelfDescription | null | undefined,
): string | null {
  const links = self_description?.links ?? [];
  if (links.length === 0) return null;
  const parts: string[] = [];
  const llms =
    links.find((l) => l.kind === "llms_full") ?? links.find((l) => l.kind === "llms_txt");
  if (llms) parts.push(`${llms.kind === "llms_full" ? "llms-full" : "llms.txt"} ${llms.url}`);
  const openapi = links.find((l) => l.kind === "openapi");
  if (openapi) parts.push(`OpenAPI ${openapi.url}`);
  const graphql = links.find((l) => l.kind === "graphql");
  if (graphql) parts.push(`GraphQL introspection ${graphql.url}`);
  if (parts.length === 0) return null;
  return `This connector publishes its own docs — fetch on demand with fetch_connector_self_description: ${parts.join(", ")}.`;
}

const SCHEMA_MAX_CONNECTORS = 3;
const SCHEMA_MAX_OPERATIONS = 24;
const SCHEMA_CHARS_BUDGET = 1800;

export async function loadConnectorSchemaSummaries(
  tenant_id: string,
  connector_ids: string[],
  exec: Executor,
): Promise<ConnectorSchemaSummary[]> {
  try {
    const ids = [...new Set(connector_ids)]
      .filter((id) => UUID_RE.test(id))
      .slice(0, SCHEMA_MAX_CONNECTORS);
    if (ids.length === 0) return [];
    const out: ConnectorSchemaSummary[] = [];
    for (const connector_id of ids) {
      const rows = await exec
        .select({
          slug: connectors.slug,
          base_url: connectors.base_url,
          self_description: connectors.self_description,
        })
        .from(connectors)
        .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, connector_id)))
        .limit(1);
      const c = rows[0];
      if (!c) continue;
      const operations: string[] = [];
      if (c.base_url) {
        const index = await readDiscoveryIndexForBaseUrl(exec, tenant_id, c.base_url);
        if (index && index.endpoints.length > 0) {
          let budget = SCHEMA_CHARS_BUDGET;
          for (const e of index.endpoints.slice(0, SCHEMA_MAX_OPERATIONS)) {
            const args = (e.params ?? []).map((p) => `${p.name}: ${p.type ?? "?"}`).join(", ");
            const name = e.operation_id ?? `${e.method} ${e.path}`;
            const sig = `${name}(${args})`;
            if (sig.length > budget) break;
            budget -= sig.length;
            operations.push(sig);
          }
        }
      }
      const selfDescriptionLine = buildSelfDescriptionLine(
        c.self_description as ConnectorSelfDescription | null,
      );
      if (operations.length > 0 || selfDescriptionLine) {
        out.push({
          connector_slug: c.slug,
          operations,
          ...(selfDescriptionLine ? { self_description_line: selfDescriptionLine } : {}),
        });
      }
    }
    return out;
  } catch (err) {
    logger.warn({
      module: "llm",
      action: "llm.context.connector_schema_skipped",
      msg: "connector discovery-index summary failed; prompt assembled without it",
      tenant_id,
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
  domains?: readonly string[],
): Promise<IncludedKnowledgeChunk[]> {
  if (!query) return [];
  try {
    const base = { tenant_id, query, ...(workflow_id ? { workflow_id } : {}), limit: 10 };
    const tags = [...new Set(domains ?? [])].map((d) => `${DOMAIN_TAG_PREFIX}${d}`);
    const narrowed = tags.length > 0 ? await searchKnowledge({ ...base, tags }, exec) : [];
    const hits = narrowed.length > 0 ? narrowed : await searchKnowledge(base, exec);
    return hits.map((h) => ({
      id: h.id,
      knowledge_source_id: h.knowledge_source_id,
      source_name: h.source_name,
      source_tags: h.source_tags,
      source_description: h.source_description,
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

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenizeForRanking(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
}

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

export function loadTopRecipeBodies(
  snapshot: Record<string, unknown> | null | undefined,
  authoringHint: AuthoringPromptHint | undefined,
  query: string,
  max = RECIPE_BODIES_TOP_K,
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
    if (!r || typeof r !== "object") {
      reportMalformedRecipe();
      continue;
    }
    const rec = r as Record<string, unknown>;
    const slug = typeof rec.slug === "string" ? rec.slug : null;
    const title = typeof rec.title === "string" ? rec.title : null;
    const workflow = rec.workflow;
    if (!slug || !title || workflow === undefined || workflow === null) {
      reportMalformedRecipe();
      continue;
    }

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

export function trimRecipeBodiesToBudget(
  templateSlug: string,
  bodies: RecipeBodyView[],
): {
  survivors: RecipeBodyView[];
  section: string | null;
  trimmed: number;
  fallback_recipe_slugs: string[];
} {
  if (bodies.length === 0) {
    return { survivors: [], section: null, trimmed: 0, fallback_recipe_slugs: [] };
  }
  const cap = RECIPE_BODIES_SECTION_CAP;

  type Rendered = { view: RecipeBodyView; text: string; fellBack: boolean };
  const rendered: Rendered[] = bodies.map((view) => ({ view, ...renderRecipeBody(view) }));
  let trimmed = 0;

  while (rendered.length > 0) {
    const sectionBase = formatConnectorRecipeBodiesFromTexts(
      templateSlug,
      rendered.map((r) => r.text),
    );
    if (sectionBase === null) break;
    const notice =
      trimmed > 0
        ? `\n\n_${trimmed} more recipe body${trimmed === 1 ? "" : "ies"} elided — token budget_`
        : "";
    const candidate = `${sectionBase}${notice}`;
    if (countTokens(candidate) <= cap) {
      return {
        survivors: rendered.map((r) => r.view),
        section: candidate,
        trimmed,
        fallback_recipe_slugs: rendered.filter((r) => r.fellBack).map((r) => r.view.recipe_slug),
      };
    }
    rendered.pop();
    trimmed += 1;
  }
  return { survivors: [], section: null, trimmed, fallback_recipe_slugs: [] };
}

function formatConnectorRecipeBodiesFromTexts(
  templateSlug: string,
  texts: string[],
): string | null {
  if (texts.length === 0) return null;
  return [
    `# Recipe bodies — connector \`${templateSlug}\``,
    "Top-K rich payloads for likely recipes. Clone via `start_workflow_from_recipe(template_slug, recipe_slug)` — no inspect_recipe round-trip needed when the workflow JSON is present below. Fall back to `inspect_recipe` only for elided bodies.",
    ...texts,
  ].join("\n\n");
}

export function logRecipeBodyFallbacks(
  templateSlug: string,
  tenant_id: string,
  bodies: RecipeBodyView[],
  fallbackSlugs: string[],
): void {
  if (fallbackSlugs.length === 0) return;
  const fallbackSet = new Set(fallbackSlugs);
  for (const body of bodies) {
    if (!fallbackSet.has(body.recipe_slug)) continue;
    logger.warn({
      module: "llm",
      action: "llm.context.recipe_body_fallback",
      msg: "recipe body exceeded soft cap; rendered hybrid payload without workflow JSON",
      tenant_id,
      template_slug: templateSlug,
      recipe_slug: body.recipe_slug,
      body_tokens: countTokens(JSON.stringify(body.workflow)),
      soft_cap_tokens: RECIPE_BODY_HYBRID_SOFT_CAP,
    });
  }
}

function reportMalformedRecipe(): void {
  try {
    getMetrics().inc(METRIC_NAMES.LLM_CONTEXT_SECTION_LOAD_FAILURES_TOTAL, {
      section: "recipe_bodies",
    });
  } catch {}
}

const WARNED_TENANTS_LRU_CAP = 256;
const proposedCandidatesFailureState = {
  warnedTenants: new Set<string>(),
};

export async function loadProposedCandidates(
  tenant_id: string,
  scope_hints: { connector_id?: string; workflow_id?: string },
  exec: Executor,
): Promise<SkillCandidateView[]> {
  try {
    return await listProposedForAuthoring(tenant_id, scope_hints, exec);
  } catch (err) {
    try {
      getMetrics().inc(METRIC_NAMES.LLM_CONTEXT_SECTION_LOAD_FAILURES_TOTAL, {
        section: "skill_candidates",
      });
    } catch {}
    const errorMessage = err instanceof Error ? err.message : String(err);
    const payload = {
      module: "llm",
      action: "llm.context.proposed_candidates_skipped",
      msg: "proposed-candidate load failed during context assembly",
      tenant_id,
      ...(scope_hints.connector_id ? { connector_id: scope_hints.connector_id } : {}),
      ...(scope_hints.workflow_id ? { workflow_id: scope_hints.workflow_id } : {}),
      error: errorMessage,
    };
    if (proposedCandidatesFailureState.warnedTenants.has(tenant_id)) {
      logger.debug(payload);
    } else {
      if (proposedCandidatesFailureState.warnedTenants.size >= WARNED_TENANTS_LRU_CAP) {
        const oldest = proposedCandidatesFailureState.warnedTenants.values().next().value;
        if (oldest !== undefined) {
          proposedCandidatesFailureState.warnedTenants.delete(oldest);
        }
      }
      proposedCandidatesFailureState.warnedTenants.add(tenant_id);
      logger.warn(payload);
    }
    return [];
  }
}

export function trimCandidatesToBudget(candidates: SkillCandidateView[]): {
  survivors: SkillCandidateView[];
  section: string | null;
  trimmed: number;
  oversized_item_id: string | null;
} {
  if (candidates.length === 0) {
    return { survivors: [], section: null, trimmed: 0, oversized_item_id: null };
  }
  const cap = SKILL_CANDIDATES_SECTION_CAP;
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

export function buildPriorWorkflowRankingQuery(
  hint: AuthoringPromptHint | undefined,
  turns: UserTurn[],
  retrievalQuery?: string,
): string {
  const explicit = retrievalQuery?.trim();
  if (explicit) return explicit.slice(0, 512);
  const parts: string[] = [];
  if (hint?.next_required_action) parts.push(hint.next_required_action);
  if (hint?.active_target?.kind) parts.push(hint.active_target.kind);
  for (const turn of turns.slice(-3)) parts.push(turn.content);
  return parts.join(" ").slice(0, 512);
}

export async function loadPriorWorkflows(
  p: {
    tenant_id: string;
    workflow_id?: string;
    connector_id?: string;
    authoring_hint?: AuthoringPromptHint;
    retrieval_query?: string;
    user_turns: UserTurn[];
  },
  exec: Executor,
): Promise<PriorWorkflowRef[]> {
  try {
    const query = buildPriorWorkflowRankingQuery(p.authoring_hint, p.user_turns, p.retrieval_query);
    return await findSimilarActive(
      p.tenant_id,
      {
        query,
        connector_ids: p.connector_id ? [p.connector_id] : [],
        ...(p.workflow_id ? { exclude_workflow_id: p.workflow_id } : {}),
      },
      PRIOR_WORKFLOWS_TOP_K,
      exec,
    );
  } catch (err) {
    logger.debug({
      module: "llm",
      subsystem: "prior_workflows",
      action: "llm.context.prior_workflows_skipped",
      msg: "prior-workflows load failed during context assembly",
      tenant_id: p.tenant_id,
      ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
