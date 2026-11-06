import { and, eq } from "drizzle-orm";
import { conversations, executions, fileLinks, files } from "../../db/schema/index.ts";
import { detectIntentSkills } from "../../llm/runtime/context-assembler.ts";
import { skillAudienceForAuthoringMode } from "../../skills/types.ts";
import { attachmentMimeTypesOf, isContinuationTurn } from "../core/loop.ts";
import { resolveScopeFactsForConversation } from "../scope-facts.ts";
import {
  autoloadForUserTurn,
  listBaselineSlugs,
  loadActivationCatalog,
  reaffirmLoadedForTurn,
} from "../skill-autoload.ts";
import { applyRecency } from "./skill-recency.ts";
import type { TurnBase, TurnSkills, TurnState } from "./types.ts";

async function hasFailedExecution(base: TurnBase): Promise<boolean> {
  const { p, workflowIdForTurn } = base;
  if (!workflowIdForTurn) return false;
  const failed = await p.db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(eq(executions.tenant_id, p.tenant_id), eq(executions.workflow_id, workflowIdForTurn)),
    )
    .limit(5);
  return failed.length > 0;
}

export async function resolveTurnSkills(base: TurnBase, state: TurnState): Promise<TurnSkills> {
  const { p, currentUserText, loadedEntries, currentTurn } = base;
  const attachmentMimeRows = await p.db
    .select({ content_type: files.content_type })
    .from(fileLinks)
    .innerJoin(files, eq(files.id, fileLinks.file_id))
    .where(
      and(
        eq(fileLinks.tenant_id, p.tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, p.conversation_id),
      ),
    );
  const attachmentMimeTypes = attachmentMimeTypesOf(attachmentMimeRows);
  const failedExecution = await hasFailedExecution(base);
  const baselineOnly = isContinuationTurn(currentUserText) && attachmentMimeTypes.length === 0;
  const intentSkillSlugs = baselineOnly
    ? []
    : await detectIntentSkills(
        p.tenant_id,
        {
          attachmentMimeTypes,
          userMessage: currentUserText,
          hasFailedExecution: failedExecution,
          hasMultipleConnectors: false,
        },
        p.db,
      );

  const loadedSlugs = loadedEntries.map((e) => e.slug);
  const skillCatalog = await loadActivationCatalog(p.tenant_id, p.db);
  const baselineSlugSet = new Set(listBaselineSlugs(skillCatalog));
  let refreshSet: Set<string>;
  let recencyAdditions: string[] = [];
  if (baselineOnly) {
    refreshSet = new Set(loadedSlugs.filter((s) => baselineSlugSet.has(s)));
  } else {
    const scope = await resolveScopeFactsForConversation(
      p.db,
      p.tenant_id,
      p.conversation_id,
      null,
    );
    const audience = skillAudienceForAuthoringMode(state.draft.summary?.mode);
    const reaffirmed = reaffirmLoadedForTurn(
      {
        mode: "user_turn",
        user_text: currentUserText,
        connector_drivers: scope.connector_drivers,
        connector_templates: scope.connector_templates,
        surface: p.surface,
        audience,
      },
      skillCatalog,
      loadedSlugs,
    );
    refreshSet = new Set<string>([
      ...loadedSlugs.filter((s) => baselineSlugSet.has(s)),
      ...reaffirmed,
    ]);
    recencyAdditions = autoloadForUserTurn(
      {
        user_text: currentUserText,
        connector_drivers: scope.connector_drivers,
        connector_templates: scope.connector_templates,
        first_turn: currentTurn === 1,
        surface: p.surface,
        audience,
      },
      skillCatalog,
      loadedSlugs,
    );
  }
  const recency = applyRecency(
    loadedEntries,
    currentTurn,
    refreshSet,
    recencyAdditions,
    baselineSlugSet,
  );
  await p.db
    .update(conversations)
    .set({ loaded_skills: recency.next })
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)));
  return {
    loadedSkillSlugs: [...new Set([...recency.fullBodySet, ...intentSkillSlugs])],
    loadedSlugMembership: recency.membership,
  };
}
