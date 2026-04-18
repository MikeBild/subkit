// load_skill tool — appends a skill's markdown body to the conversation's
// volatile context block for the remainder of the session. The loaded
// skill set is persisted on `conversations.loaded_skills` so resumed
// sessions keep their palette.
//
// This tool also unlocks any `tenant_write` tools that declare a
// `requires_skill` gate — see `tools/gated.ts`.

import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { conversations } from "../../db/schema/index.ts";
import type { ConversationTool } from "./index.ts";

const Input = z.object({ slug: z.string().min(1) }).openapi("LoadSkillToolInput");

export const loadSkillTool: ConversationTool = {
  name: "load_skill",
  description:
    "Load a named skill into the current conversation context, unlocking any tools that require it. Call once per skill; subsequent turns see the skill body in the volatile context block.",
  inputSchema: Input,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    // Verify the skill exists in the tenant. `slug` is matched against
    // either skill id or title (case-insensitive) since the Skill type
    // does not carry a dedicated slug column.
    const candidates = await ctx.engineClient.skills.list();
    const match = candidates.find(
      (s) => s.id === args.slug || s.title.toLowerCase() === args.slug.toLowerCase(),
    );
    if (!match) return { ok: false, data: { error: "skill_not_found", slug: args.slug } };

    const rows = await ctx.db
      .select({ loaded_skills: conversations.loaded_skills })
      .from(conversations)
      .where(eq(conversations.id, ctx.conversation_id))
      .limit(1);
    const current = (rows[0]?.loaded_skills ?? []) as string[];
    const key = match.id;
    if (current.includes(key)) {
      return {
        ok: true,
        data: { slug: key, already_loaded: true, skill: { id: match.id, title: match.title } },
      };
    }
    const next = [...current, key];
    await ctx.db
      .update(conversations)
      .set({ loaded_skills: next })
      .where(eq(conversations.id, ctx.conversation_id));

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
