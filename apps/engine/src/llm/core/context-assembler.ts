import { getConnector } from "../../connectors/service.ts";
import { type Db, getDb } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { idHashesCapped } from "../../observability/id-hashes.ts";
import {
  recordAuthoringContextSkillsUsed,
  recordLlmContextAssembled,
} from "../../observability/instrumentation.ts";
import { loadActiveConventions, NO_CONVENTIONS } from "../../skills/conventions.ts";
import { retrieveApplicableSkills } from "../../skills/service.ts";
import { type Skill, skillOfferedTo } from "../../skills/types.ts";
import { listWorkflowToolSlugs } from "../../workflows/catalog.ts";
import type { PriorWorkflowRef } from "../../workflows/prior-workflows.ts";
import { contextCapFor, countMessagesTokens, countTokens } from "../accounting/index.ts";
import { LlmContextTooLarge } from "../errors.ts";
import { renderRuntimeContextBlock } from "../runtime-context.ts";
import type {
  AssembleContextParams,
  EnhancedPrompt,
  IncludedChunk,
  IncludedKnowledgeChunk,
  UserTurn,
} from "../types.ts";
import { type CacheBlocks, splitPromptIntoBlocks } from "./cache-blocks.ts";
import { basePromptFor, type ConversationSurface } from "./context-assembler/base-prompts.ts";
import {
  applyRuntimeTemplate,
  conventionsTrimReference,
  formatAppliedConventions,
  formatChunk,
  formatConnectorRecipes,
  formatFailure,
  formatInteractionLog,
  formatKnowledgeChunk,
  formatLatestPreview,
  formatOperatorQuirks,
  formatSkill,
  formatSkillIndex,
  formatUserMemory,
  type RecipeBodyView,
  selectOperatorQuirkCategories,
  trimPriorWorkflowsToBudget,
} from "./context-assembler/formatters.ts";
import { resolveLoadedSkills } from "./context-assembler/loaded-skills.ts";
import {
  type InteractionLogEntry,
  type LatestPreviewEntry,
  loadChunks,
  loadConnectorAuthoringAids,
  loadInteractionLog,
  loadKnowledgeChunks,
  loadLatestPreview,
  loadPriorWorkflows,
  loadTopRecipeBodies,
  logRecipeBodyFallbacks,
  trimRecipeBodiesToBudget,
} from "./context-assembler/loaders.ts";
import { promptSkillAudience } from "./context-assembler/skill-audience.ts";
import { recordConversationBudgetReport } from "./conversation-budget-report.ts";
import { loadTenantSummary, renderTenantSummaryBlock } from "./tenant-summary.ts";

export {
  basePromptFor,
  type ConversationSurface,
} from "./context-assembler/base-prompts.ts";
export {
  applyRuntimeTemplate,
  countSkillTokens,
  formatConnectorRecipes,
  formatOperatorQuirks,
  formatSkillIndex,
  selectOperatorQuirkCategories,
} from "./context-assembler/formatters.ts";
export { detectIntentSkills } from "./context-assembler/skill-picker.ts";

export function buildQuery(turns: UserTurn[], retrievalQuery?: string): string {
  const explicit = retrievalQuery?.trim();
  if (explicit) return explicit.slice(0, 512);
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
    recipe_bodies: number;
    conventions: number;
    prior_workflows: number;
  };
  dropped_sections: string[];
}

export interface AssembledContext {
  prompt: EnhancedPrompt;
  blocks: CacheBlocks;
  budget_report: BudgetReport;
}

export { promptSkillAudience } from "./context-assembler/skill-audience.ts";

export async function assembleEnhancedPrompt(
  p: AssembleContextParams & { surface?: ConversationSurface },
  exec?: Db,
): Promise<
  EnhancedPrompt & {
    dropped_sections: string[];
    included_recipe_slugs: string[];
    included_convention_rule_ids: string[];
    included_prior_workflow_slugs: string[];
  }
> {
  const db = exec ?? getDb();
  const cap = Math.min(p.max_tokens, contextCapFor(p.model ?? "default"));

  const basePrompt = await basePromptFor(p.flow, p.surface, p.authoring_hint);
  const baseSystem = applyRuntimeTemplate(basePrompt.content, p.runtime_context);
  const baseVolatile = basePrompt.volatile
    ? applyRuntimeTemplate(basePrompt.volatile, p.runtime_context)
    : null;
  const audience = promptSkillAudience(p.flow, p.authoring_hint?.mode);
  const scopedConnectorIds = [
    ...new Set([...(p.connector_id ? [p.connector_id] : []), ...(p.connector_ids ?? [])]),
  ];
  const skillsApplicable = await retrieveApplicableSkills(
    {
      tenant_id: p.tenant_id,
      ...(scopedConnectorIds.length > 0 ? { connector_ids: scopedConnectorIds } : {}),
      ...(p.workflow_id ? { workflow_ids: [p.workflow_id] } : {}),
      audience,
    },
    db,
  );

  const generating = p.flow === "generate";
  const skillIndexMode = generating ? "guidance" : "interactive";
  const globalSkills = skillsApplicable.filter((s) => s.scope === "global");
  const connectorSkills = skillsApplicable.filter((s) => s.scope === "connector");
  const workflowSkills = skillsApplicable.filter((s) => s.scope === "workflow");

  const loadedSkillSlugs = p.loaded_skill_slugs ?? [];
  const membershipSlugs = p.loaded_skill_membership ?? [];
  const resolvedLoaded = await resolveLoadedSkills(
    p.tenant_id,
    loadedSkillSlugs,
    membershipSlugs,
    skillsApplicable,
    db,
  );
  const offered = (s: Skill) => skillOfferedTo(s.applies_to, audience);
  const loadedSkills = resolvedLoaded.fullBody.filter(offered);
  const loadedIndexSkills = resolvedLoaded.index.filter(offered);

  const query = buildQuery(p.user_turns, p.retrieval_query);

  const preEmbedCorpus = p.flow !== "converse" && p.flow !== "summarize";
  const knowledgeChunks: IncludedKnowledgeChunk[] = [];
  const chunks: IncludedChunk[] = [];
  if (preEmbedCorpus) {
    const knowledgeBudget = Math.floor(cap * 0.15);
    const rawKnowledgeChunks = await loadKnowledgeChunks(
      p.tenant_id,
      p.workflow_id,
      query,
      db,
      p.domains,
    );
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
  let referencedEntitiesBlock: string | null = p.referenced_entities?.block ?? null;

  let interactionLogEntries: InteractionLogEntry[] = [];
  if (p.flow === "converse" && p.conversation_id) {
    interactionLogEntries = await loadInteractionLog(p.tenant_id, p.conversation_id, db);
  }

  let latestPreviewEntries: LatestPreviewEntry[] = [];
  if (p.flow === "converse" && p.conversation_id) {
    latestPreviewEntries = await loadLatestPreview(p.tenant_id, p.conversation_id, db);
  }

  let { probeShapeExamplesBlock, connectorSchemaBlock } = await loadConnectorAuthoringAids(p, db);

  const quirkBlocks: string[] = [];
  const recipeBlocks: string[] = [];
  const recipeBodyBlocks: string[] = [];
  let connectorRecipeBodiesSurvivors: RecipeBodyView[] = [];
  const quirkCategories = selectOperatorQuirkCategories(
    p.authoring_hint,
    (failures?.length ?? 0) > 0,
  );
  for (const connectorId of scopedConnectorIds) {
    try {
      const connector = await getConnector(p.tenant_id, connectorId, db);
      const quirks = connector?.operator_quirks ?? {};
      if (connector && Object.keys(quirks).length > 0) {
        const block = formatOperatorQuirks(
          connector.slug,
          connector.display_name,
          quirks,
          quirkCategories,
        );
        if (block) quirkBlocks.push(block);
      }
      if (connector?.template_snapshot) {
        const snapshot = connector.template_snapshot as Record<string, unknown>;
        const recipes = formatConnectorRecipes(connector.slug, snapshot);
        if (recipes) recipeBlocks.push(recipes);
        const recipeBodies = loadTopRecipeBodies(snapshot, p.authoring_hint, query);
        if (recipeBodies.length > 0) {
          const trimmed = trimRecipeBodiesToBudget(connector.slug, recipeBodies);
          if (trimmed.section) recipeBodyBlocks.push(trimmed.section);
          connectorRecipeBodiesSurvivors = [
            ...connectorRecipeBodiesSurvivors,
            ...trimmed.survivors,
          ];
          logRecipeBodyFallbacks(
            connector.slug,
            p.tenant_id,
            trimmed.survivors,
            trimmed.fallback_recipe_slugs,
          );
        }
      }
    } catch (err) {
      logger.debug({
        module: "llm",
        action: "llm.context.operator_quirks_skipped",
        msg: "operator_quirks load failed during context assembly",
        tenant_id: p.tenant_id,
        connector_id: connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let connectorOperatorQuirksBlock: string | null =
    quirkBlocks.length > 0 ? quirkBlocks.join("\n\n") : null;
  let connectorRecipesBlock: string | null =
    recipeBlocks.length > 0 ? recipeBlocks.join("\n\n") : null;
  let connectorRecipeBodiesBlock: string | null =
    recipeBodyBlocks.length > 0 ? recipeBodyBlocks.join("\n\n") : null;

  let priorWorkflowsBlock: string | null = null;
  let priorWorkflowsSurvivors: PriorWorkflowRef[] = [];
  if (preEmbedCorpus) {
    const refs = await loadPriorWorkflows(
      {
        tenant_id: p.tenant_id,
        ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
        ...(p.connector_id ? { connector_id: p.connector_id } : {}),
        ...(p.authoring_hint ? { authoring_hint: p.authoring_hint } : {}),
        ...(p.retrieval_query?.trim() ? { retrieval_query: p.retrieval_query } : {}),
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

  const conventionsMode = generating ? "generate" : "interactive";
  const activeConventions =
    p.flow === "generate" || p.flow === "converse"
      ? await loadActiveConventions(
          p.tenant_id,
          {
            connector_ids: scopedConnectorIds,
            workflow_id: p.workflow_id ?? null,
            categories: p.domains ?? [],
          },
          db,
        )
      : NO_CONVENTIONS;
  const conventionsSection = formatAppliedConventions(activeConventions, conventionsMode);
  let conventionsBlock = conventionsSection?.section ?? null;
  const conventionsTrimRef = conventionsSection
    ? conventionsTrimReference(activeConventions, conventionsMode)
    : null;

  const runtimeBlock = p.runtime_context
    ? renderRuntimeContextBlock({
        ...(p.runtime_context.engine_url ? { engine_url: p.runtime_context.engine_url } : {}),
        ...(p.runtime_context.tenant_slug ? { tenant_slug: p.runtime_context.tenant_slug } : {}),
        ...(p.runtime_context.actor_email ? { actor_email: p.runtime_context.actor_email } : {}),
        ...(p.runtime_context.actor_role ? { actor_role: p.runtime_context.actor_role } : {}),
        ...(p.runtime_context.surface ? { surface: p.runtime_context.surface } : {}),
      })
    : null;

  const tenantSummaryBlock =
    p.flow === "converse" && p.principal
      ? renderTenantSummaryBlock(
          ...(await Promise.all([
            loadTenantSummary(p.principal, db),
            listWorkflowToolSlugs({ db, principal: p.principal, request_source: "chat" }),
          ])),
        )
      : null;

  let lastSections: Array<{ text: string; volatile: boolean }> = [];
  const render = () => {
    const sections: string[] = [];
    const volatileTexts = new Set<string>();
    const vol = (text: string) => {
      volatileTexts.add(text);
      sections.push(text);
    };
    sections.push(baseSystem);
    if (runtimeBlock) vol(runtimeBlock);
    const globalIndexBlock = formatSkillIndex(
      "Global",
      globalSkills,
      p.runtime_context,
      skillIndexMode,
    );
    const connectorIndexBlock = formatSkillIndex(
      "Connector",
      connectorSkills,
      p.runtime_context,
      skillIndexMode,
    );
    const workflowIndexBlock = formatSkillIndex(
      "Workflow",
      workflowSkills,
      p.runtime_context,
      skillIndexMode,
    );
    if (globalIndexBlock) sections.push(globalIndexBlock);
    if (connectorOperatorQuirksBlock) sections.push(connectorOperatorQuirksBlock);
    if (connectorRecipesBlock) sections.push(connectorRecipesBlock);
    if (connectorRecipeBodiesBlock) sections.push(connectorRecipeBodiesBlock);
    if (priorWorkflowsBlock) sections.push(priorWorkflowsBlock);
    if (connectorIndexBlock) sections.push(connectorIndexBlock);
    if (workflowIndexBlock) sections.push(workflowIndexBlock);
    if (conventionsBlock) sections.push(conventionsBlock);
    for (const s of loadedSkills) sections.push(formatSkill(s, p.runtime_context));
    const loadedIndexBlock = formatSkillIndex(
      "Loaded",
      loadedIndexSkills,
      p.runtime_context,
      generating ? "catalog" : "interactive",
    );
    if (loadedIndexBlock) sections.push(loadedIndexBlock);
    for (const kc of knowledgeChunks) sections.push(formatKnowledgeChunk(kc));
    if (userMemory) vol(formatUserMemory(userMemory));
    for (const c of chunks) sections.push(formatChunk(c));
    if (connectorSchemaBlock) sections.push(connectorSchemaBlock);
    if (probeShapeExamplesBlock) sections.push(probeShapeExamplesBlock);
    if (latestPreviewEntries.length > 0) {
      vol(formatLatestPreview(latestPreviewEntries));
    }
    if (interactionLogEntries.length > 0) {
      vol(formatInteractionLog(interactionLogEntries));
    }
    for (const f of failures) vol(formatFailure(f));
    if (tenantSummaryBlock) vol(tenantSummaryBlock);
    if (baseVolatile) vol(baseVolatile);
    if (authoringContext) vol(authoringContext);
    if (p.automation_context) vol(p.automation_context);
    if (referencedEntitiesBlock) vol(referencedEntitiesBlock);
    lastSections = sections.map((text) => ({ text, volatile: volatileTexts.has(text) }));
    return sections.join("\n\n");
  };

  let system = render();
  let systemTokens = countTokens(system);
  const messagesTokens = countMessagesTokens(p.user_turns);
  let total = systemTokens + messagesTokens;

  const recount = () => {
    system = render();
    systemTokens = countTokens(system);
    total = systemTokens + messagesTokens;
  };

  const trimmed: string[] = [];
  const CONNECTOR_SCHEMA_TRIM_REF = generating
    ? "# Connector operations\n[omitted because the context budget is exhausted; no discovery tool is available in this call. If a required operation contract is missing, abort and ask the outer agent to supply the exact schema. Never guess.]"
    : "# Connector operations (from the connector's schema)\n[trimmed to fit the context budget — call discover_connector_endpoints to reload the real operation index; do not guess operation or argument names]";
  const PROBE_SAMPLES_TRIM_REF = generating
    ? "# Recorded endpoint samples\n[omitted because the context budget is exhausted; no probe tool is available in this call. If a required response shape is missing, abort and identify the exact evidence the outer agent must supply. Never guess.]"
    : "# Recorded endpoint samples\n[trimmed to fit the context budget — probe_connector / call_connector re-record real response shapes; suggest_jsonata_paths serves the field vocabulary. Do not guess field names]";
  const SKILL_BODY_SUMMARY_LIMIT = 100;
  const trimSkill = (s: Skill): typeof s => {
    if (s.body.length <= SKILL_BODY_SUMMARY_LIMIT) return s;
    return {
      ...s,
      body: `${s.body.slice(0, SKILL_BODY_SUMMARY_LIMIT).trim()}… [load_skill('${s.title ?? s.id}') for full body]`,
    };
  };
  let trimmedLoadedCursor = 0;
  while (total > cap) {
    if (interactionLogEntries.length > 0) {
      interactionLogEntries = [];
      trimmed.push("interaction_log");
    } else if (failures.length > 0) {
      failures = [];
      trimmed.push("failures");
    } else if (connectorSchemaBlock && connectorSchemaBlock !== CONNECTOR_SCHEMA_TRIM_REF) {
      connectorSchemaBlock = CONNECTOR_SCHEMA_TRIM_REF;
      trimmed.push("connector_schema_summary");
    } else if (probeShapeExamplesBlock && probeShapeExamplesBlock !== PROBE_SAMPLES_TRIM_REF) {
      probeShapeExamplesBlock = PROBE_SAMPLES_TRIM_REF;
      trimmed.push("recorded_endpoint_samples");
    } else if (chunks.length > 0) {
      chunks.pop();
      trimmed.push("docs");
    } else if (latestPreviewEntries.length > 0) {
      latestPreviewEntries = [];
      trimmed.push("latest_preview");
    } else if (knowledgeChunks.length > 0) {
      knowledgeChunks.pop();
      trimmed.push("knowledge");
    } else if (userMemory) {
      userMemory = "";
      trimmed.push("user_memory");
    } else if (
      referencedEntitiesBlock &&
      p.referenced_entities &&
      referencedEntitiesBlock !== p.referenced_entities.trim_ref
    ) {
      referencedEntitiesBlock = p.referenced_entities.trim_ref;
      trimmed.push("referenced_entities");
    } else if (authoringContext) {
      authoringContext = "";
      trimmed.push("authoring_context");
    } else if (conventionsBlock && conventionsTrimRef && conventionsBlock !== conventionsTrimRef) {
      conventionsBlock = conventionsTrimRef;
      trimmed.push("applied_conventions");
    } else if (
      !generating &&
      loadedSkills.length > 0 &&
      trimmedLoadedCursor < loadedSkills.length
    ) {
      const idx = trimmedLoadedCursor++;
      const cur = loadedSkills[idx];
      if (cur && cur.body.length > SKILL_BODY_SUMMARY_LIMIT) {
        loadedSkills[idx] = trimSkill(cur);
        trimmed.push("loaded_skill_body_trimmed");
      }
    } else if (!generating && loadedSkills.length > 0) {
      loadedSkills.pop();
      trimmed.push("loaded_skill");
    } else if (loadedIndexSkills.length > 0) {
      loadedIndexSkills.length = 0;
      trimmed.push("loaded_skill_index");
    } else if (!generating && workflowSkills.length > 0) {
      workflowSkills.length = 0;
      trimmed.push("workflow_skill_index");
    } else if (!generating && connectorSkills.length > 0) {
      connectorSkills.length = 0;
      trimmed.push("connector_skill_index");
    } else if (priorWorkflowsBlock) {
      priorWorkflowsBlock = null;
      priorWorkflowsSurvivors = [];
      trimmed.push("prior_workflows");
    } else if (connectorRecipeBodiesBlock) {
      connectorRecipeBodiesBlock = null;
      trimmed.push("connector_recipe_bodies");
    } else if (connectorRecipesBlock) {
      connectorRecipesBlock = null;
      trimmed.push("connector_recipes");
    } else if (connectorOperatorQuirksBlock) {
      connectorOperatorQuirksBlock = null;
      trimmed.push("connector_operator_quirks");
    } else if (!generating && globalSkills.length > 0) {
      globalSkills.length = 0;
      trimmed.push("global_skill_index");
    } else if (connectorSchemaBlock || probeShapeExamplesBlock) {
      connectorSchemaBlock = null;
      probeShapeExamplesBlock = null;
      trimmed.push("authoring_evidence_refs");
    } else if (referencedEntitiesBlock) {
      referencedEntitiesBlock = null;
      trimmed.push("referenced_entities_ref");
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
      throw new LlmContextTooLarge(
        generating
          ? "The generation goal and complete approved skill guidance exceed the context budget. Narrow the workflow scope or provide a larger verified model context; generation cannot omit required guidance or call tools to reload it."
          : "prompt exceeds model context window after trimming",
        { total, cap },
      );
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
  const recipeBodiesTokens =
    connectorRecipeBodiesBlock !== null ? countTokens(connectorRecipeBodiesBlock) : 0;
  const conventionsTokens = conventionsBlock !== null ? countTokens(conventionsBlock) : 0;
  const priorWorkflowsTokens = priorWorkflowsBlock !== null ? countTokens(priorWorkflowsBlock) : 0;
  const ambientSkillTokens =
    countTokens(formatSkillIndex("Global", globalSkills, p.runtime_context, skillIndexMode) ?? "") +
    countTokens(
      formatSkillIndex("Connector", connectorSkills, p.runtime_context, skillIndexMode) ?? "",
    ) +
    countTokens(
      formatSkillIndex("Workflow", workflowSkills, p.runtime_context, skillIndexMode) ?? "",
    );
  const loadedSkillTokens = loadedSkills.reduce(
    (t, s) => t + countTokens(formatSkill(s, p.runtime_context)),
    0,
  );
  const includedRecipeSlugs =
    connectorRecipeBodiesBlock !== null
      ? connectorRecipeBodiesSurvivors.map((r) => r.recipe_slug)
      : [];
  const includedConventionRuleIds =
    conventionsSection && conventionsBlock === conventionsSection.section
      ? conventionsSection.included.map((entry) => entry.rule.rule_id)
      : [];
  const includedPriorWorkflowSlugs =
    priorWorkflowsBlock !== null ? priorWorkflowsSurvivors.map((r) => r.slug) : [];
  return {
    system,
    system_sections: lastSections,
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
      conventions: conventionsTokens,
      prior_workflows: priorWorkflowsTokens,
      references: referencedEntitiesBlock ? countTokens(referencedEntitiesBlock) : 0,
    },
    included_skill_ids: includedSkills.map((s) => s.id),
    included_chunk_ids: chunks.map((c) => c.id),
    included_knowledge_chunk_ids: knowledgeChunks.map((kc) => kc.id),
    included_skills: includedSkills,
    included_chunks: chunks,
    included_knowledge_chunks: knowledgeChunks,
    dropped_sections: trimmed,
    included_recipe_slugs: includedRecipeSlugs,
    included_convention_rule_ids: includedConventionRuleIds,
    included_prior_workflow_slugs: includedPriorWorkflowSlugs,
  };
}

export async function assembleContext(
  params: AssembleContextParams,
  exec?: Db,
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
    included_convention_rule_ids,
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
      recipe_bodies: included_recipe_slugs.length,
      conventions: included_convention_rule_ids.length,
      prior_workflows: included_prior_workflow_slugs.length,
    },
    dropped_sections,
  };

  const idHashes = (ids: string[]): string[] => idHashesCapped(ids);

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
    included_recipe_slugs: included_recipe_slugs.slice(0, 12),
    included_prior_workflow_slugs: included_prior_workflow_slugs.slice(0, 12),
    dropped_sections: budget_report.dropped_sections,
    section_tokens: prompt.token_counts,
  });

  if (params.conversation_id) {
    recordConversationBudgetReport(params.tenant_id, params.conversation_id, {
      cap_tokens: budget_report.cap_tokens,
      total_tokens: budget_report.total_tokens,
      dropped_sections: budget_report.dropped_sections,
      assembled_at: new Date().toISOString(),
    });
  }

  const promotedSkillCount = prompt.included_skills.filter((s) => s.source === "candidate").length;
  recordAuthoringContextSkillsUsed({
    tenant_id: params.tenant_id,
    source: "catalog",
    count: promotedSkillCount,
  });

  return {
    prompt: promptWithoutDropped,
    blocks,
    budget_report,
  };
}
