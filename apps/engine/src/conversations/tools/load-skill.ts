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

/** Classic O(n·m) edit distance — small inputs (skill slug list),
 *  avoids pulling in a lib. */
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
    "Load a named skill into the current conversation context, unlocking any tools that require it. Call once per skill; subsequent turns see the skill body in the volatile context block.",
  use_case:
    "Pull domain knowledge into the working context before authoring a connector, workflow, or approving a patch. Also unlocks skill-gated tools (see `requires_skill`).",
  important_notes: [
    "Skills are stored per tenant — the same slug may resolve to different bodies across tenants.",
    "Loaded skills persist across turns of the same conversation; calling twice is a no-op.",
    "Available slugs include: subkit-concepts, workflow-authoring, http-connectors, postgres-connectors, graphql-connectors, s3-connectors, data-handling, rbac-and-scopes, self-healing, error-recovery.",
  ],
  example_input: { slug: "workflow-authoring" },
  inputSchema: Input,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    const wanted = args.slug.toLowerCase();
    // Match by slug (preferred, stable cross-tenant id) or fall through
    // to id / title for legacy callers.
    const candidates = await ctx.engineClient.skills.list();
    const match = candidates.find(
      (s) =>
        (s.slug ?? "").toLowerCase() === wanted ||
        s.id === args.slug ||
        s.title.toLowerCase() === wanted,
    );
    if (!match) {
      // Suggest the closest slugs so the model doesn't retry blindly.
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

    const rows = await ctx.db
      .select({ loaded_skills: conversations.loaded_skills })
      .from(conversations)
      .where(eq(conversations.id, ctx.conversation_id))
      .limit(1);
    const current = (rows[0]?.loaded_skills ?? []) as string[];
    // Persist the SLUG (not the UUID id) so downstream palette gating
    // and prompt-context lookup can both rely on the stable cross-tenant
    // identifier. The context-assembler already accepts id-or-slug for
    // backwards compat with any rows that still hold UUIDs.
    const key = match.slug ?? match.id;
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
