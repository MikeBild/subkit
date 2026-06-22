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
// The assembler is split across `context-assembler/`:
//
//   - `context-assembler/loaders.ts`      — DB-side loaders
//                                            (interaction log, latest
//                                            preview, doc / knowledge
//                                            chunks)
//   - `context-assembler/formatters.ts`   — pure markdown rendering
//                                            (skills, quirks, recipes,
//                                            chunks, failures, memory,
//                                            preview, log)
//   - `context-assembler/skill-picker.ts` — `detectIntentSkills`
//                                            keyword → auto-load
//                                            dispatch
//
// External callers continue to import `assembleEnhancedPrompt`,
// `assembleContext`, `basePromptFor`, `applyRuntimeTemplate`,
// `formatSkillIndex`, `countSkillTokens`, `formatOperatorQuirks`,
// `formatConnectorRecipes`, `selectOperatorQuirkCategories`,
// `detectIntentSkills`, and the `AssembledContext` / `BudgetReport`
// types from this barrel.

import { getConnector } from "../../connectors/service.ts";
import { generateMainAgentSystemPrompt } from "../../conversations/agent/context.ts";
import { type Executor, getDb } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { idHashesCapped } from "../../observability/id-hashes.ts";
import {
  recordAuthoringContextSkillsUsed,
  recordLlmContextAssembled,
} from "../../observability/instrumentation.ts";
import { retrieveApplicableSkills } from "../../skills/service.ts";
import type { Skill } from "../../skills/types.ts";
import type { PriorWorkflowRef } from "../../workflows/prior-workflows.ts";
import { contextCapFor, countMessagesTokens, countTokens } from "../accounting/index.ts";
import { LlmContextTooLarge } from "../errors.ts";
import { renderRuntimeContextBlock } from "../runtime-context.ts";
import type {
  AssembleContextParams,
  AuthoringPromptHint,
  EnhancedPrompt,
  IncludedChunk,
  IncludedKnowledgeChunk,
  LlmFlow,
  UserTurn,
} from "../types.ts";
import { type CacheBlocks, splitPromptIntoBlocks } from "./cache-blocks.ts";
import {
  formatChunk,
  formatConnectorRecipes,
  formatFailure,
  formatInteractionLog,
  formatKnowledgeChunk,
  formatLatestPreview,
  formatOperatorQuirks,
  formatProbeShapeExamples,
  formatSkill,
  formatSkillIndex,
  formatUserMemory,
  type RecipeBodyView,
  SKILL_CANDIDATES_SECTION_CAP,
  selectOperatorQuirkCategories,
  trimPriorWorkflowsToBudget,
} from "./context-assembler/formatters.ts";
import { resolveLoadedSkills } from "./context-assembler/loaded-skills.ts";
import {
  type InteractionLogEntry,
  type LatestPreviewEntry,
  loadChunks,
  loadInteractionLog,
  loadKnowledgeChunks,
  loadLatestPreview,
  loadPriorWorkflows,
  loadProbeShapeExamples,
  loadProposedCandidates,
  loadTopRecipeBodies,
  logRecipeBodyFallbacks,
  trimCandidatesToBudget,
  trimRecipeBodiesToBudget,
} from "./context-assembler/loaders.ts";
import { loadTenantSummary, renderTenantSummaryBlock } from "./tenant-summary.ts";

export type ConversationSurface = "sk_headless" | "sk_interactive" | "mcp" | "web";

export {
  applyRuntimeTemplate,
  countSkillTokens,
  formatConnectorRecipes,
  formatOperatorQuirks,
  formatSkillIndex,
  selectOperatorQuirkCategories,
} from "./context-assembler/formatters.ts";
export { detectIntentSkills } from "./context-assembler/skill-picker.ts";

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

// `suggest_next` is excluded because it has its own minimal prompt
// assembler (`llm/core/suggestion-prompt.ts`) that intentionally does
// NOT load skills / knowledge / docs — adding it here would invite a
// future refactor that re-routes it through `assembleEnhancedPrompt`
// and re-introduces the 1M-token empty-turn bug class.
const BASE_SYSTEM_PROMPTS: Record<Exclude<LlmFlow, "converse" | "suggest_next">, string> = {
  generate: [
    "You are the subkit workflow engine's generate flow.",
    "Turn the user's description into a typed WorkflowDef draft.",
    "A WorkflowDef has a `name`, optional `slug` / `description`, and an ordered `steps[]` array.",
    "Each step has `kind` (one of: request, transform, call, wait, branch, parallel, loop) and a unique `id`.",
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
  judge: [
    "You are the subkit workflow engine's preview judge — a strict, deterministic evaluator.",
    "You are given the user's goal verbatim, a compact summary of the workflow definition, and the recorded step outputs from a green preview.",
    "Decide whether the previewed OUTPUT satisfies the goal. Judge content, not style: minor format differences are fine, but an empty value where the goal requires data is never a pass.",
    "Return exactly one JSON object: { verdict, reason, missing }.",
  ].join(" "),
  critic_authoring: [
    "You are the subkit workflow engine's authoring critic.",
    "A draft has already passed static checks (JSONata syntax, scope references, JSON-schema validity).",
    "Your only job is to flag SEMANTIC drift and STRUCTURAL-QUALITY problems that static checks cannot catch:",
    "steps in an order that produces nonsense (e.g. transform before the request it reads);",
    "`output_transform` that names fields the upstream step does not produce;",
    "idempotency assumptions that won't hold (retrying a POST without an idempotency key, etc.);",
    "AVOIDABLE SEQUENTIAL WORK — a `loop` whose body is independent READ requests (GET / query / SELECT): it runs serially and pays N× wall-clock; flag it and suggest a `for_each` step, which fans out reads concurrently;",
    "SILENT DATA LOSS — a transform with a catch-all that returns ''/null/[] for unmatched input, or an `output_transform`/projection that drops fields the goal needs; flag the dropped data;",
    "INCOMPLETE TRAVERSAL — fetching only the top level of a paginated or TREE resource (e.g. one `/children` call where nested nodes have `has_children`) when the goal implies all items/descendants; flag the missing pagination or depth.",
    "Report problems. Do NOT propose code or patches.",
    "If everything looks reasonable, return passed:true with an empty repairs array.",
    "Cap repairs at 5 short, imperative sentences. Each item must be actionable in a single edit.",
    "rationale is a one-paragraph explanation of the call; keep it under 800 characters.",
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
  if (flow === "suggest_next") {
    // `suggest_next` is intentionally outside this assembler's purview
    // — see the BASE_SYSTEM_PROMPTS comment above. Callers must use
    // `llm/core/suggestion-prompt.ts` directly. Throwing here keeps a
    // future drift towards the heavy assembler from compiling.
    throw new Error("basePromptFor: suggest_next must use suggestion-prompt.ts");
  }
  return BASE_SYSTEM_PROMPTS[flow];
}

function buildQuery(turns: UserTurn[]): string {
  const tail = turns.slice(-3).map((t) => t.content);
  return tail.join(" ").slice(0, 512);
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
    /** Count of recipe-body items rendered into the prompt. */
    recipe_bodies: number;
    /** Count of proposed Skill Candidates rendered into the prompt. */
    candidates: number;
    /** Count of Prior Workflow reference cases rendered into the
     *  prompt. Always 0 in the converse flow. */
    prior_workflows: number;
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
): Promise<
  EnhancedPrompt & {
    dropped_sections: string[];
    /** Recipe slugs whose rich body survived BOTH the intra-section
     *  trim AND the global trimmer — fed verbatim to the observability
     *  hash list in `assembleContext`. */
    included_recipe_slugs: string[];
    /** Candidate ids likewise. Empty when the section was dropped. */
    included_candidate_ids: string[];
    /** Prior-workflow slugs whose ref survived BOTH the intra-section
     *  trim AND the global trimmer. Empty in converse flow (section is
     *  not loaded) or when the section was dropped to fit the cap. */
    included_prior_workflow_slugs: string[];
  }
> {
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

  // On-demand skills (load_skill) + index-safety. `loaded_skill_slugs`
  // (the recency window) renders FULL bodies; `loaded_skill_membership`
  // (everything still loaded but aged out of the window) renders through
  // the "Loaded" index so no skill disappears. Resolution and the
  // slug↔id↔scope de-duplication live in the recency-aware loader; the
  // returned arrays stay mutable here because the token-budget trimmer
  // below shrinks/pops them when the prompt overflows.
  const loadedSkillSlugs = p.loaded_skill_slugs ?? [];
  const membershipSlugs = p.loaded_skill_membership ?? [];
  const resolvedLoaded = await resolveLoadedSkills(
    p.tenant_id,
    loadedSkillSlugs,
    membershipSlugs,
    skillsApplicable,
    db,
  );
  const loadedSkills = resolvedLoaded.fullBody;
  const loadedIndexSkills = resolvedLoaded.index;

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

  // Recorded endpoint samples — payload-first generation context. The
  // latest observed response shapes (`schema_versions`, recorded by
  // probe_connector / call_connector / request-step executions) for the
  // connectors bound to the conversation's draft. Rendered ONLY in
  // workflow-authoring mode: that is the moment the model writes
  // request paths and transforms, and the shapes must reach it BEFORE
  // it authors — not as an after-the-fact validation finding.
  let probeShapeExamplesBlock: string | null = null;
  if (
    p.flow === "converse" &&
    p.authoring_hint?.mode === "workflow" &&
    p.authoring_connector_ids &&
    p.authoring_connector_ids.length > 0
  ) {
    const shapeExamples = await loadProbeShapeExamples(p.tenant_id, p.authoring_connector_ids, db);
    if (shapeExamples.length > 0) {
      probeShapeExamplesBlock = formatProbeShapeExamples(shapeExamples);
    }
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
  let connectorRecipeBodiesBlock: string | null = null;
  let connectorRecipeBodiesSurvivors: RecipeBodyView[] = [];
  let connectorRecipeBodiesTemplateSlug: string | null = null;
  let connectorRecipeBodiesFallbackSlugs: string[] = [];
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
        const snapshot = connector.template_snapshot as Record<string, unknown>;
        connectorRecipesBlock = formatConnectorRecipes(connector.slug, snapshot);
        // Recipe bodies — rich payload for the top-K ranked recipes so
        // the LLM can clone via start_workflow_from_recipe in one turn
        // (no inspect_recipe round-trip). Pure ranking over the already-
        // loaded snapshot — no second getConnector. Section is bounded
        // by `trimRecipeBodiesToBudget` to 2 KB; rendered string already
        // carries the elision notice when something was dropped.
        const recipeBodies = loadTopRecipeBodies(snapshot, p.authoring_hint, query);
        if (recipeBodies.length > 0) {
          const trimmed = trimRecipeBodiesToBudget(connector.slug, recipeBodies);
          connectorRecipeBodiesBlock = trimmed.section;
          connectorRecipeBodiesSurvivors = trimmed.survivors;
          connectorRecipeBodiesTemplateSlug = connector.slug;
          connectorRecipeBodiesFallbackSlugs = trimmed.fallback_recipe_slugs;
        }
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

  // Hybrid-fallback log — one warning per surviving recipe that rendered
  // without its workflow JSON (per-body soft-cap exceeded). Emitted
  // exactly once per assembly, after the trim loop decided the final
  // set, so the render-and-count loop never produces duplicate warnings.
  if (connectorRecipeBodiesTemplateSlug && connectorRecipeBodiesFallbackSlugs.length > 0) {
    logRecipeBodyFallbacks(
      connectorRecipeBodiesTemplateSlug,
      p.tenant_id,
      connectorRecipeBodiesSurvivors,
      connectorRecipeBodiesFallbackSlugs,
    );
  }

  // Prior workflows — 5th authoring context source. Compressed
  // reference cases from this tenant's most similar active workflows,
  // surfaced so the LLM grounds new drafts in patterns the team has
  // already used. Gated by `preEmbedCorpus`: the converse flow
  // deliberately omits this section (workflows are discoverable via
  // the always-on tenant snapshot + the `find_workflow` tool); only
  // the structured authoring flows (`generate`, `repair`, `extract`,
  // `discover`, `summarize`) pre-embed.
  let priorWorkflowsBlock: string | null = null;
  let priorWorkflowsSurvivors: PriorWorkflowRef[] = [];
  if (preEmbedCorpus) {
    const refs = await loadPriorWorkflows(
      {
        tenant_id: p.tenant_id,
        ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
        ...(p.connector_id ? { connector_id: p.connector_id } : {}),
        ...(p.authoring_hint ? { authoring_hint: p.authoring_hint } : {}),
        user_turns: p.user_turns,
      },
      db,
    );
    if (refs.length > 0) {
      const trimmed = trimPriorWorkflowsToBudget(refs);
      priorWorkflowsBlock = trimmed.section;
      priorWorkflowsSurvivors = trimmed.survivors;
    }
  }

  // Skill candidates — proposed (status=proposed) candidates the LLM
  // should see this turn so detected patterns reach the prompt without
  // waiting for operator promotion. Sibling block to the connector
  // load above: lives OUTSIDE the `if (p.connector_id)` so global
  // candidates render even when no connector is in scope; workflow-
  // scoped candidates render whenever `p.workflow_id` is set.
  //
  // Gate: converse flow only. Non-converse flows (`generate`, `repair`,
  // `extract`, `summarize`, `discover`) skip this load entirely — they
  // do not steer the authoring loop, so injecting candidate hints
  // would burn tokens for no behavioural payoff. Effective contract:
  // "converse flow AND (global OR scope-hint matches)".
  // `listProposedForAuthoring` makes 1-3 indexed queries; best-effort
  // try/catch matches the existing pattern — a DB blip never blocks
  // assembly.
  let skillCandidatesBlock: string | null = null;
  let skillCandidatesOversizedItemId: string | null = null;
  let skillCandidateSurvivorIds: string[] = [];
  if (p.flow === "converse") {
    const candidates = await loadProposedCandidates(
      p.tenant_id,
      {
        ...(p.connector_id ? { connector_id: p.connector_id } : {}),
        ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
      },
      db,
    );
    if (candidates.length > 0) {
      const trimmed = trimCandidatesToBudget(candidates);
      skillCandidatesBlock = trimmed.section;
      skillCandidatesOversizedItemId = trimmed.oversized_item_id;
      skillCandidateSurvivorIds = trimmed.survivors.map((c) => c.id);
    }
  }

  // Oversized-survivor warning — emitted exactly once when the trim
  // loop ended with a single survivor still over cap (body was
  // token-truncated to ceil(cap * 0.9)). Operators grep this to find
  // self-healing detectors emitting oversized candidate bodies.
  if (skillCandidatesOversizedItemId !== null) {
    logger.warn({
      module: "llm",
      action: "llm.context.section_oversized_item",
      msg: "candidate body exceeded section cap; body truncated for fit",
      tenant_id: p.tenant_id,
      section: "skill_candidates",
      item_id: skillCandidatesOversizedItemId,
      cap_tokens: SKILL_CANDIDATES_SECTION_CAP,
    });
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
    // Rich recipe bodies sit next to the slim recipe roster so the LLM
    // reads "here's the slug list" → "here's the workflow JSON for the
    // top picks" together. Drops before the index above when the global
    // trimmer needs room (the slim roster keeps the LLM able to call
    // inspect_recipe for anything that fell off).
    if (connectorRecipeBodiesBlock) sections.push(connectorRecipeBodiesBlock);
    // Prior workflows — reference cases from this tenant's own active
    // workflows, surfaced next to connector recipes so the LLM reads
    // "templates to clone" → "patterns this team already uses"
    // together. Marked `[reference, not template]` per its own header
    // so the model never confuses the two surfaces.
    if (priorWorkflowsBlock) sections.push(priorWorkflowsBlock);
    if (connectorIndexBlock) sections.push(connectorIndexBlock);
    if (workflowIndexBlock) sections.push(workflowIndexBlock);
    // Loaded skills carry the full body — they are loaded AND within the
    // K-turn recency window, so the cost is justified.
    for (const s of loadedSkills) sections.push(formatSkill(s, p.runtime_context));
    // Index-safety "Loaded" block: ever-loaded skills that aged out of
    // the full-body window (or are out-of-scope / experimental) stay
    // referenceable as a one-line index entry. `load_skill('<slug>')`
    // re-promotes any of them to a full body for the next K turns.
    const loadedIndexBlock = formatSkillIndex("Loaded", loadedIndexSkills, p.runtime_context);
    if (loadedIndexBlock) sections.push(loadedIndexBlock);
    // Proposed skill candidates render next to loaded skills — same
    // shape (full prose body, scope, best practices, pitfalls), lower
    // confidence. Marked `[pending approval]` so the LLM treats them as
    // hints, not authoritative rules. Drops BEFORE recipe bodies in the
    // ladder (promoted skills are the durable surface; candidates are
    // the cheapest section to lose without breaking authoring).
    if (skillCandidatesBlock) sections.push(skillCandidatesBlock);
    for (const kc of knowledgeChunks) sections.push(formatKnowledgeChunk(kc));
    if (userMemory) sections.push(formatUserMemory(userMemory));
    for (const c of chunks) sections.push(formatChunk(c));
    // Recorded endpoint samples render right above the latest preview:
    // the model reads "what the endpoints return" → "what the last
    // dry-run actually produced" together, in the same `$scope.<id>.data…`
    // addressing vocabulary.
    if (probeShapeExamplesBlock) sections.push(probeShapeExamplesBlock);
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
  //   interaction log → failures → recorded endpoint samples →
  //   connector docs → latest preview → knowledge chunks → user memory →
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
  const trimSkill = (s: Skill): typeof s => {
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
    } else if (probeShapeExamplesBlock) {
      // Recorded endpoint samples drop EARLY — well before any skill
      // section. They are a grounding aid the model can re-derive on
      // demand (call_connector / probe_connector re-record on the next
      // call; suggest_jsonata_paths serves the same vocabulary), so
      // they are the cheapest authoring section to shed under pressure.
      probeShapeExamplesBlock = null;
      trimmed.push("recorded_endpoint_samples");
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
    } else if (loadedIndexSkills.length > 0) {
      // The "Loaded" index (aged-out / out-of-scope loaded skills) is a
      // one-line-per-skill navigational aid — drop it wholesale once the
      // full-body loaded skills are gone. The slug stays recoverable via
      // load_skill regardless.
      loadedIndexSkills.length = 0;
      trimmed.push("loaded_skill_index");
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
    } else if (skillCandidatesBlock) {
      // Skill candidates drop BEFORE recipe bodies: promoted skills
      // (those that survived approval and now live in the global /
      // connector / workflow skill scope) are the durable surface; a
      // candidate is by construction speculative. Losing it just means
      // the LLM can't see a pattern the self-healer detected but the
      // operator hasn't yet promoted — recoverable on the next turn.
      skillCandidatesBlock = null;
      trimmed.push("skill_candidates");
    } else if (priorWorkflowsBlock) {
      // Prior workflows drop between skill_candidates and
      // connector_recipe_bodies: a reference case is informational
      // (the LLM can still call `find_workflow` / `get_workflow` to
      // re-discover it), whereas connector recipes are first-turn-
      // clone payloads with a much higher per-turn payoff. When the
      // budget gets tight, drop the references first.
      priorWorkflowsBlock = null;
      priorWorkflowsSurvivors = [];
      trimmed.push("prior_workflows");
    } else if (connectorRecipeBodiesBlock) {
      // Rich recipe bodies drop BEFORE the slim recipe roster: the
      // index is the navigational signal (the LLM can still call
      // inspect_recipe to recover any body), the bodies are the
      // first-turn-clone payload. When the global budget is tight,
      // surrender the heavy section first.
      connectorRecipeBodiesBlock = null;
      trimmed.push("connector_recipe_bodies");
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
  // Post-trim per-section token accounting. Each bucket reads the
  // rendered (already trimmed) block when it survived the global
  // trimmer; reads 0 when dropped. The producer (this function)
  // populates every key — consumers never default with `?? 0`.
  const recipeBodiesTokens =
    connectorRecipeBodiesBlock !== null ? countTokens(connectorRecipeBodiesBlock) : 0;
  const skillCandidatesTokens =
    skillCandidatesBlock !== null ? countTokens(skillCandidatesBlock) : 0;
  const priorWorkflowsTokens = priorWorkflowsBlock !== null ? countTokens(priorWorkflowsBlock) : 0;
  const ambientSkillTokens =
    countTokens(formatSkillIndex("Global", globalSkills, p.runtime_context) ?? "") +
    countTokens(formatSkillIndex("Connector", connectorSkills, p.runtime_context) ?? "") +
    countTokens(formatSkillIndex("Workflow", workflowSkills, p.runtime_context) ?? "");
  const loadedSkillTokens = loadedSkills.reduce(
    (t, s) => t + countTokens(formatSkill(s, p.runtime_context)),
    0,
  );
  // Survivor lists: only items in blocks the global trimmer kept count.
  // When the section was dropped above, the ids zero out — so the
  // observability hashes report exactly what the LLM actually saw.
  const includedRecipeSlugs =
    connectorRecipeBodiesBlock !== null
      ? connectorRecipeBodiesSurvivors.map((r) => r.recipe_slug)
      : [];
  const includedCandidateIds = skillCandidatesBlock !== null ? skillCandidateSurvivorIds : [];
  const includedPriorWorkflowSlugs =
    priorWorkflowsBlock !== null ? priorWorkflowsSurvivors.map((r) => r.slug) : [];
  return {
    system,
    messages: p.user_turns,
    token_counts: {
      system: systemTokens,
      skills: ambientSkillTokens + loadedSkillTokens,
      knowledge: knowledgeChunks.reduce((t, kc) => t + kc.tokens, 0),
      docs: chunks.reduce((t, c) => t + c.tokens, 0),
      failures: failures.reduce((t, f) => t + countTokens(formatFailure(f)), 0),
      messages: messagesTokens,
      total,
      recipe_bodies: recipeBodiesTokens,
      skill_candidates: skillCandidatesTokens,
      prior_workflows: priorWorkflowsTokens,
    },
    included_skill_ids: includedSkills.map((s) => s.id),
    included_chunk_ids: chunks.map((c) => c.id),
    included_knowledge_chunk_ids: knowledgeChunks.map((kc) => kc.id),
    included_skills: includedSkills,
    included_chunks: chunks,
    included_knowledge_chunks: knowledgeChunks,
    dropped_sections: trimmed,
    included_recipe_slugs: includedRecipeSlugs,
    included_candidate_ids: includedCandidateIds,
    included_prior_workflow_slugs: includedPriorWorkflowSlugs,
  };
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

  const {
    dropped_sections,
    included_recipe_slugs,
    included_candidate_ids,
    included_prior_workflow_slugs,
    ...promptWithoutDropped
  } = prompt;

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
      // Counts that survived BOTH the per-section pre-trim AND the
      // global trimmer — what the LLM actually saw on this turn.
      recipe_bodies: included_recipe_slugs.length,
      candidates: included_candidate_ids.length,
      prior_workflows: included_prior_workflow_slugs.length,
    },
    dropped_sections,
  };

  // Per-id 8-char SHA-256 hashes — capped at 12 entries per category
  // (top-N selection cap plus headroom). Operators can grep "did this
  // turn see X?" by hashing X locally and looking for the 8-char prefix.
  // No metric labels carry hashes — keeps cardinality bounded.
  // Correlation-grade obfuscation only, NOT a security boundary.
  const idHashes = (ids: string[]): string[] => idHashesCapped(ids);

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
    included_skill_id_hashes: idHashes(prompt.included_skill_ids),
    included_candidate_id_hashes: idHashes(included_candidate_ids),
    // Recipe slugs are low-cardinality + already operator-visible in
    // connector templates; hashing them would force operators to
    // round-trip through sha256sum to read the log line. Emit the raw
    // slugs (still capped at 12 — the same headroom as the hash lists).
    //
    // Cardinality assumption: `template_snapshot.recipes[].slug` stays
    // operator-curated and bounded. If recipes ever become user-authorable
    // (each tenant defines its own), this becomes a log-line cardinality
    // problem and the slugs should switch to hashed via `idHashes` like
    // the other id arrays.
    included_recipe_slugs: included_recipe_slugs.slice(0, 12),
    // Prior-workflow slugs are tenant-internal and bounded — at most
    // `PRIOR_WORKFLOWS_TOP_K` per turn. Emitted raw (capped at 12 for
    // log-line bounds, same headroom as recipes).
    included_prior_workflow_slugs: included_prior_workflow_slugs.slice(0, 12),
    dropped_sections: budget_report.dropped_sections,
    section_tokens: prompt.token_counts,
  });

  // Closing edge of the Run → Drift → Patch → Skill loop (docs/06-execution.md):
  // record which loop-originated skills actually influenced this authoring
  // turn. `catalog` counts ONLY Skills promoted from a Skill Candidate
  // (source === "candidate") — not engine-shipped seed/template/manual skills,
  // which are always-on and would otherwise drown the loop-closure signal.
  // `candidate` counts proposed Skill Candidates surfaced for review. Both
  // counts come from data already in hand — pure in-memory increments.
  const promotedSkillCount = prompt.included_skills.filter((s) => s.source === "candidate").length;
  recordAuthoringContextSkillsUsed({
    tenant_id: params.tenant_id,
    source: "catalog",
    count: promotedSkillCount,
  });
  recordAuthoringContextSkillsUsed({
    tenant_id: params.tenant_id,
    source: "candidate",
    count: budget_report.included.candidates,
  });

  return {
    prompt: promptWithoutDropped,
    blocks,
    budget_report,
  };
}
