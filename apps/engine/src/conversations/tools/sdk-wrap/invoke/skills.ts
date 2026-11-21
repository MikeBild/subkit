import type { Db } from "../../../../db/client.ts";
import { logger } from "../../../../logging/index.ts";
import { skillAudienceForAuthoringMode } from "../../../../skills/types.ts";
import { parseLoadedSkills } from "../../../loop/skill-recency.ts";
import { resolveScopeFactsForConversation } from "../../../scope-facts.ts";
import {
  readConversationSkillState,
  setConversationLoadedSkills,
} from "../../../service/tool-state.ts";
import {
  autoloadForDiagnoses,
  autoloadForToolCall,
  diagnosisCodesFromToolResult,
  loadActivationCatalog,
  reaffirmLoadedForTurn,
} from "../../../skill-autoload.ts";
import type { ToolContext } from "../../index.ts";
import type { InvokeEnv } from "./env.ts";

function warnAutoloadFailed(ctx: ToolContext, tool: string, err: unknown): void {
  logger.warn({
    module: "conversations.skill_autoload",
    action: "skill_autoload.failed",
    conversation_id: ctx.conversation_id,
    tool,
    error: err instanceof Error ? err.message : String(err),
  });
}

export async function autoloadForResultDiagnoses(
  db: Db,
  ctx: ToolContext,
  tool: string,
  resultPayload: unknown,
): Promise<void> {
  const codes = diagnosisCodesFromToolResult(resultPayload);
  if (codes.length === 0) return;
  try {
    const scope = { tenant_id: ctx.tenant_id, conversation_id: ctx.conversation_id };
    const row = await readConversationSkillState(db, scope);
    const entries = parseLoadedSkills(row?.loaded_skills, () => {});
    const additions = autoloadForDiagnoses(
      codes,
      await loadActivationCatalog(ctx.tenant_id, db),
      entries.map((e) => e.slug),
      ctx.surface,
      skillAudienceForAuthoringMode(ctx.getDraft().summary?.mode),
    );
    if (additions.length === 0) return;
    const turn = row?.turn_count ?? 0;
    await setConversationLoadedSkills(db, scope, [
      ...entries,
      ...additions.map((slug) => ({ slug, last_turn: turn })),
    ]);
    logger.debug({
      module: "conversations.skill_autoload",
      action: "skill_autoload.diagnosis_applied",
      conversation_id: ctx.conversation_id,
      tool,
      diagnosis_codes: codes,
      added_skills: additions,
    });
  } catch (err) {
    warnAutoloadFailed(ctx, tool, err);
  }
}

export async function autoloadForCall(
  env: InvokeEnv,
  rawArgs: Record<string, unknown>,
): Promise<void> {
  const { inner, ctx, db } = env;
  try {
    const skillScope = { tenant_id: ctx.tenant_id, conversation_id: ctx.conversation_id };
    const convRow = await readConversationSkillState(db, skillScope);
    const currentEntries = parseLoadedSkills(convRow?.loaded_skills, ({ dropped, raw }) =>
      logger.warn({
        module: "conversation",
        action: "skill_recency.malformed_loaded_skills",
        msg: "dropped malformed loaded_skills entries during tool-call autoload",
        conversation_id: ctx.conversation_id,
        tenant_id: ctx.tenant_id,
        dropped,
        raw,
      }),
    );
    const currentTurn = convRow?.turn_count ?? 0;
    const membership = currentEntries.map((e) => e.slug);
    const [catalog, scope] = await Promise.all([
      loadActivationCatalog(ctx.tenant_id, db),
      resolveScopeFactsForConversation(db, ctx.tenant_id, ctx.conversation_id, rawArgs),
    ]);
    const audience = skillAudienceForAuthoringMode(ctx.getDraft().summary?.mode);
    const additions = autoloadForToolCall(
      { tool: inner.name, input: rawArgs, ...scope, audience },
      catalog,
      membership,
    );
    const reaffirmed = new Set(
      reaffirmLoadedForTurn(
        { mode: "tool_call", tool: inner.name, input: rawArgs, ...scope, audience },
        catalog,
        membership,
      ),
    );
    if (additions.length > 0 || reaffirmed.size > 0) {
      const refreshed = currentEntries.map((e) =>
        reaffirmed.has(e.slug) ? { slug: e.slug, last_turn: currentTurn } : e,
      );
      const next = [...refreshed, ...additions.map((slug) => ({ slug, last_turn: currentTurn }))];
      await setConversationLoadedSkills(db, skillScope, next);
      logger.debug({
        module: "conversations.skill_autoload",
        action: "skill_autoload.applied",
        conversation_id: ctx.conversation_id,
        tool: inner.name,
        added_skills: additions,
        reaffirmed_skills: [...reaffirmed],
      });
    }
  } catch (err) {
    warnAutoloadFailed(ctx, inner.name, err);
  }
}
