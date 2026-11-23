import { z } from "@hono/zod-openapi";
import { listedDescription } from "../../api/catalog-metadata.ts";
import { listSkills } from "../../skills/service.ts";
import { rankedPage } from "./catalog-rank.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Free-text query. Ranked by category, title, description, then scope and body; each match says why it matched. Use "*" to list all.',
      ),
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
  category: string;
  body_preview: string;
}

function summarize(s: {
  id: string;
  title: string;
  scope: string;
  body: string;
  description: string | null;
  category: string;
}): SkillSummary {
  const preview = s.body
    .replace(/^---[\s\S]*?---\s*/, "")
    .trim()
    .slice(0, 120);
  return {
    id: s.id,
    title: s.title,
    scope: s.scope,
    description: listedDescription(s.description),
    category: s.category,
    body_preview: preview,
  };
}

function rankFields(s: SkillSummary) {
  return {
    category: [s.category],
    identity: [s.title],
    description: [s.description],
    detail: [s.scope, s.body_preview],
  };
}

export const findSkillTool: ConversationTool = {
  name: "find_skill",
  description:
    "Search the skill library by free-text query. Returns top matches with a short body preview. Pair with load_skill to pull the full body of a chosen skill.",
  use_case:
    'Operator asks "is there a skill for Stripe webhooks?" — find_skill returns the catalog entries that match, then load_skill fetches the body.',
  important_notes: [
    "Distinct from list_skill_suggestions (heuristic relevance against user message). find_skill is a direct keyword query.",
    "When no query matches, returns no matches and a `hint` instead of the unfiltered list.",
  ],
  inputSchema,
  category: "tenant_read",
  permission: { action: "skill:read", resourceType: "skill" },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const all = await listSkills({ tenant_id: ctx.tenant_id }, ctx.db);
    const filtered = args.scope ? all.filter((s) => s.scope === args.scope) : all;
    const summaries = filtered.map(summarize);
    return {
      ok: true,
      data: rankedPage(args.query, summaries, rankFields, args.limit, "list_skills"),
    };
  },
};
