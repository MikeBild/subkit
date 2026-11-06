import { z } from "@hono/zod-openapi";
import { recordConversationSkillLoaded } from "../../audit/recorders/index.ts";
import { logger } from "../../logging/logger.ts";
import { parseLoadedSkills } from "../loop/skill-recency.ts";
import { readConversationSkillState, setConversationLoadedSkills } from "../service/tool-state.ts";
import { auditActorFromToolContext } from "./audit-actor.ts";
import type { ConversationTool } from "./index.ts";

const Input = z.object({ slug: z.string().min(1) }).openapi("LoadSkillToolInput");

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let next = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(next + 1, prev[j]! + 1, prev[j - 1]! + cost);
      prev[j - 1] = next;
      next = v;
    }
    prev[b.length] = next;
  }
  return prev[b.length]!;
}

export const loadSkillTool: ConversationTool = {
  name: "load_skill",
  description:
    "Load a named skill into the current conversation context, unlocking any tools that require it. The result carries the skill body, also when the skill was already marked loaded by its activation rules.",
  use_case:
    "Pull domain knowledge into the working context before authoring a connector, workflow, or approving a patch. Also unlocks skill-gated tools (see `requires_skill`).",
  important_notes: [
    "Skills are stored per tenant — the same slug may resolve to different bodies across tenants.",
    "Loaded skills persist across turns of the same conversation; calling again returns the body once more without adding the skill twice.",
    "Available slugs include: subkit-concepts, workflow-authoring, http-connectors, postgres-connectors, graphql-connectors, s3-connectors, data-handling, rbac-and-scopes, self-healing, error-recovery.",
    "workflow-authoring is the core recipe; its topic rules are separate workflow-authoring-* skills (structures, transforms, repair, automation, boundaries, schedules, output-format, product-callers, transactional-mail, loop-examples). Their tools, step kinds and diagnosis codes mark them loaded, but their bodies arrive only through this tool: load the topic before acting on it.",
  ],
  example_input: { slug: "workflow-authoring" },
  inputSchema: Input,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    const wanted = args.slug.toLowerCase();
    const candidates = await ctx.engineClient.skills.list();
    const match = candidates.find(
      (s) =>
        (s.slug ?? "").toLowerCase() === wanted ||
        s.id === args.slug ||
        s.title.toLowerCase() === wanted,
    );
    if (!match) {
      const pool = candidates
        .map((s) => s.slug ?? s.title.toLowerCase().replace(/\s+/g, "-"))
        .filter((x): x is string => !!x);
      const suggestions = pool
        .map((slug) => ({ slug, score: levenshtein(wanted, slug.toLowerCase()) }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 3)
        .filter((s) => s.score <= Math.max(3, Math.floor(wanted.length / 2)))
        .map((s) => s.slug);
      return {
        ok: false,
        data: {
          error: "skill_not_found",
          slug: args.slug,
          suggested_slugs: suggestions,
          available_slugs: pool.slice(0, 20),
        },
      };
    }

    const scope = { tenant_id: ctx.tenant_id, conversation_id: ctx.conversation_id };
    const state = await readConversationSkillState(ctx.db, scope);
    const current = parseLoadedSkills(state?.loaded_skills, ({ dropped, raw }) =>
      logger.warn({
        module: "conversation",
        action: "skill_recency.malformed_loaded_skills",
        msg: "dropped malformed loaded_skills entries in load_skill",
        conversation_id: ctx.conversation_id,
        tenant_id: ctx.tenant_id,
        dropped,
        raw,
      }),
    );
    const currentTurn = state?.turn_count ?? 0;
    const key = match.slug ?? match.id;
    if (current.some((e) => e.slug === key)) {
      const refreshed = current.map((e) =>
        e.slug === key ? { slug: key, last_turn: currentTurn } : e,
      );
      await setConversationLoadedSkills(ctx.db, scope, refreshed);
      await recordConversationSkillLoaded({
        tenant_id: ctx.tenant_id,
        ...auditActorFromToolContext(ctx),
        conversation_id: ctx.conversation_id,
        skill_id: match.id,
        skill_slug: key,
        skill_title: match.title,
        already_loaded: true,
        executor: ctx.db,
      });
      return {
        ok: true,
        data: {
          slug: key,
          already_loaded: true,
          skill: { id: match.id, title: match.title, body: match.body, scope: match.scope },
        },
      };
    }
    const next = [...current, { slug: key, last_turn: currentTurn }];
    await setConversationLoadedSkills(ctx.db, scope, next);
    await recordConversationSkillLoaded({
      tenant_id: ctx.tenant_id,
      ...auditActorFromToolContext(ctx),
      conversation_id: ctx.conversation_id,
      skill_id: match.id,
      skill_slug: key,
      skill_title: match.title,
      already_loaded: false,
      executor: ctx.db,
    });

    return {
      ok: true,
      data: {
        slug: key,
        skill: {
          id: match.id,
          title: match.title,
          body: match.body,
          scope: match.scope,
        },
        loaded_count: next.length,
      },
    };
  },
};
