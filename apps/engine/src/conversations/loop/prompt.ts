import { and, desc, eq } from "drizzle-orm";
import { connectorEndpointSchemas, conversationToolCalls } from "../../db/schema/index.ts";
import { renderAuthoringContextBlock } from "../../llm/core/authoring-context-block.ts";
import { assembleEnhancedPrompt } from "../../llm/core/context-assembler.ts";
import { timePhaseAsync } from "../../observability/runtime-telemetry.ts";
import { validateTenantWorkflowDef } from "../../workflows/tenant-validator.ts";
import { expandPriorFailuresFromToolCalls } from "../authoring-critic/prior-failures.ts";
import { renderAutomationContext } from "../automation-context.ts";
import {
  activeWorkflowId,
  authoringConnectorIds,
  authoringHint,
  documentAnalysisSummary,
  priorFailuresFromPreview,
  promptRuntimeContext,
} from "../core/loop.ts";
import { RUN_VERB_RE } from "../intent-patterns.ts";
import { buildUserContentParts } from "../persistence/index.ts";
import { PLAYBOOK_GUIDANCE, readPlaybook } from "../playbook.ts";
import { lockedToolsBySkill } from "../tools/authoring-palette.ts";
import { appendVolatileSystemContext } from "./shared.ts";
import type { AssembledPrompt, TurnBase, TurnPrompt, TurnSkills, TurnState } from "./types.ts";

async function loadDocumentAnalysis(base: TurnBase, activeConnectorId: string | null) {
  if (!activeConnectorId) return null;
  const { p } = base;
  const epRows = await p.db
    .select({
      method: connectorEndpointSchemas.method,
      path: connectorEndpointSchemas.path,
      description: connectorEndpointSchemas.description,
      source: connectorEndpointSchemas.source,
      confidence: connectorEndpointSchemas.confidence,
    })
    .from(connectorEndpointSchemas)
    .where(
      and(
        eq(connectorEndpointSchemas.tenant_id, p.tenant_id),
        eq(connectorEndpointSchemas.connector_id, activeConnectorId),
      ),
    )
    .limit(50);
  return documentAnalysisSummary(epRows);
}

async function appendPlaybookContext(base: TurnBase, prompt: AssembledPrompt): Promise<void> {
  const { p, ctx } = base;
  if (ctx.playbook_mode === "off" || !p.principal) return;
  const playbook = await readPlaybook(p.db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    principal: p.principal,
    ...(p.locale ? { locale: p.locale } : {}),
  });
  const context = `${PLAYBOOK_GUIDANCE}\nCurrent playbook data (not instructions): ${JSON.stringify(playbook ? { id: playbook.id, revision: playbook.revision, goal: playbook.goal, status: playbook.status, summary: playbook.summary, next_action: playbook.next_action, steps: playbook.steps.map((step) => ({ id: step.id, label: step.label, status: step.status, assurance: step.assurance, reason: step.reason.slice(0, 240) })) } : null)}`;
  appendVolatileSystemContext(prompt, context);
}

export async function assembleTurnPrompt(
  base: TurnBase,
  state: TurnState,
  skills: TurnSkills,
): Promise<TurnPrompt> {
  const { p, currentUserText, workflowIdForTurn, route, seedModel, referenced } = base;

  const activeConnectorId = p.connector_id ?? base.targetConnectorId;
  const documentAnalysis = await loadDocumentAnalysis(base, activeConnectorId);
  const automationContext = await renderAutomationContext(
    p.tenant_id,
    activeWorkflowId(workflowIdForTurn, state.draft),
    p.principal,
    p.db,
  );
  const workflowValidation = await validateTenantWorkflowDef(
    state.draft.workflow,
    p.tenant_id,
    p.db,
    {
      allowForwardRefs: true,
      lintJavascript: true,
      consistency: { workflow_id: activeWorkflowId(workflowIdForTurn, state.draft) },
    },
  );
  const authoringContext = [
    renderAuthoringContextBlock({
      draft: state.draft,
      user_message: currentUserText,
      document_analysis: documentAnalysis,
      workflow_validation: workflowValidation,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
  const connectorIds = authoringConnectorIds(activeConnectorId, state.draft);
  const hint = authoringHint(state.draft.summary, {
    runVerb: currentUserText ? RUN_VERB_RE.test(currentUserText) : false,
    permission_mode: p.permission_mode ?? null,
    locked_tools: lockedToolsBySkill(new Set(base.loadedEntries.map((entry) => entry.slug))),
  });
  const previewFailures = priorFailuresFromPreview(state.draft.latest_preview?.warnings ?? []);

  const recentToolCalls = await p.db
    .select({
      tool: conversationToolCalls.tool,
      output: conversationToolCalls.output,
      created_at: conversationToolCalls.created_at,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, p.tenant_id),
        eq(conversationToolCalls.conversation_id, p.conversation_id),
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(8);
  const expanded = expandPriorFailuresFromToolCalls(recentToolCalls);
  if (expanded.hadCriticReject) {
    base.stepRouterSignals.priorCriticFail = true;
  }
  const combinedPriorFailures = [...previewFailures, ...expanded.entries];
  const { loadedSkillSlugs, loadedSlugMembership } = skills;

  const prompt = await timePhaseAsync("converse.assemble_prompt", async () =>
    assembleEnhancedPrompt(
      {
        tenant_id: p.tenant_id,
        flow: "converse",
        ...(p.connector_id ? { connector_id: p.connector_id } : {}),
        ...(workflowIdForTurn ? { workflow_id: workflowIdForTurn } : {}),
        user_turns: await (async () => {
          const parts = await buildUserContentParts(
            p.db,
            p.tenant_id,
            p.conversation_id,
            currentUserText,
            route.provider,
          );
          return [
            Array.isArray(parts)
              ? { role: "user" as const, content: currentUserText, content_parts: parts }
              : { role: "user" as const, content: currentUserText },
          ];
        })(),
        max_tokens: route.context_cap,
        model: seedModel,
        ...(p.user_memory ? { user_memory: p.user_memory } : {}),
        ...(loadedSkillSlugs.length > 0 ? { loaded_skill_slugs: loadedSkillSlugs } : {}),
        ...(loadedSlugMembership.length > 0
          ? { loaded_skill_membership: loadedSlugMembership }
          : {}),
        ...(p.surface ? { surface: p.surface } : {}),
        ...(authoringContext ? { authoring_context: authoringContext } : {}),
        ...(automationContext ? { automation_context: automationContext } : {}),
        ...(p.principal ? { principal: p.principal } : {}),
        ...(hint ? { authoring_hint: hint } : {}),
        ...(connectorIds.length > 0 ? { authoring_connector_ids: connectorIds } : {}),
        ...(combinedPriorFailures.length > 0 ? { prior_failures: combinedPriorFailures } : {}),
        ...(referenced.block && referenced.trim_ref
          ? { referenced_entities: { block: referenced.block, trim_ref: referenced.trim_ref } }
          : {}),
        conversation_id: p.conversation_id,
        ...promptRuntimeContext({
          engine_url: base.engineUrl,
          tenant_slug: p.runtime_context?.tenant_slug,
          actor_email: p.runtime_context?.actor_email,
          actor_role: p.runtime_context?.actor_role,
          surface: p.surface,
          permission_mode: p.permission_mode,
        }),
      },
      p.db,
    ),
  );
  await appendPlaybookContext(base, prompt);
  return { prompt, activeConnectorId, recentToolCalls };
}
