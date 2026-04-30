// find_skill — fuzzy keyword lookup over the entire skill library
// (global + per-tenant + per-resource scopes). Pairs with load_skill:
// find_skill discovers candidates, load_skill pulls the body.
//
// Distinct from list_skill_suggestions which uses heuristic relevance
// against the user message; find_skill is a direct keyword query.

import { z } from "@hono/zod-openapi";
import { listSkills } from "../../skills/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { keywordSearch } from "./keyword-search.ts";

const inputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe('Free-text query. Matches skill id/title/description/scope. Use "*" to list all.'),
    scope: z
      .enum(["global", "connector", "workflow"])
      .optional()
      .describe("Filter to skills of a specific scope."),
    limit: z.number().int().min(1).max(30).default(8),
  })
  .openapi("FindSkillToolInput");

interface SkillSummary {
  id: string;
  title: string;
  scope: string;
  description: string | null;
  body_preview: string;
}

function summarize(s: { id: string; title?: string; scope: string; body?: string }): SkillSummary {
  const body = s.body ?? "";
  // Pull the first description-shaped line: prefer a `description:`
  // frontmatter line, otherwise the first 120 chars of body sans
  // markdown noise.
  const descMatch = body.match(/^description:\s*(.*?)$/m);
  const description = descMatch?.[1]?.trim() ?? null;
  const preview = body
    .replace(/^---[\s\S]*?---\s*/, "")
    .trim()
    .slice(0, 120);
  return {
    id: s.id,
    title: s.title ?? s.id,
    scope: s.scope,
    description,
    body_preview: preview,
  };
}

function searchableText(s: SkillSummary): string {
  return [s.id, s.title, s.scope, s.description ?? "", s.body_preview].filter(Boolean).join(" ");
}

export const findSkillTool: ConversationTool = {
  name: "find_skill",
  description:
    "Search the skill library by free-text query. Returns top matches with a short body preview. Pair with load_skill to pull the full body of a chosen skill.",
  use_case:
    'Operator asks "is there a skill for Stripe webhooks?" — find_skill returns the catalog entries that match, then load_skill fetches the body.',
  important_notes: [
    "Distinct from list_skill_suggestions (heuristic relevance against user message). find_skill is a direct keyword query.",
    "When no query matches, returns the unfiltered list capped at `limit`.",
  ],
  inputSchema,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const all = await listSkills({ tenant_id: ctx.tenant_id }, ctx.db);
    const filtered = args.scope ? all.filter((s) => s.scope === args.scope) : all;
    const summaries = filtered.map(summarize);
    const ranked = keywordSearch(args.query ?? "*", summaries, searchableText);
    const limited = ranked.slice(0, args.limit);
    return {
      ok: true,
      data: {
        matches: limited,
        total: ranked.length,
        ...(ranked.length > limited.length ? { truncated: true } : {}),
      },
    };
  },
};
