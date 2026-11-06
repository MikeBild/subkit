import { z } from "@hono/zod-openapi";
import { SkillCandidateStatusSchema } from "../../../skill-candidates/types.ts";
import type { ConversationTool } from "../index.ts";

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

const ListInput = z
  .object({
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
    status: SkillCandidateStatusSchema.optional().describe("Only candidates in this status"),
  })
  .openapi("ListSkillCandidatesToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetSkillCandidateToolInput");

export const listSkillCandidatesTool: ConversationTool = {
  name: "list_skill_candidates",
  description:
    "List Skill Candidates — auto-proposed workflow patterns detected from execution history, awaiting approval. Returns one page (default 50, max 200, newest first) with `total`, `has_more` and `next_offset`; per item id, title, status, pattern_kind, scope, confidence, evidence_count, created_at. When `has_more` is true the list is incomplete: page through with `offset` before drawing conclusions such as duplicates.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof ListInput>) {
    const limit = args.limit ?? LIST_DEFAULT_LIMIT;
    const offset = args.offset ?? 0;
    const filter = args.status ? { status: args.status } : {};
    const [rows, total] = await Promise.all([
      ctx.engineClient.skillCandidates.list({ limit, offset, ...filter }),
      ctx.engineClient.skillCandidates.count(filter),
    ]);
    const hasMore = offset + rows.length < total;
    return {
      ok: true,
      data: {
        total,
        limit,
        offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + rows.length } : {}),
        candidates: rows.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          pattern_kind: c.pattern_kind,
          scope: c.scope,
          confidence: c.confidence,
          evidence_count: c.evidence_count,
          created_at: c.created_at,
        })),
      },
    };
  },
};

const getSkillCandidateTool: ConversationTool = {
  name: "get_skill_candidate",
  description: "Fetch one skill candidate with evidence and proposed body.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof GetInput>) {
    const c = await ctx.engineClient.skillCandidates.get(args.id);
    if (!c) return { ok: false, data: { error: "skill_candidate_not_found" } };
    return { ok: true, data: { candidate: c } };
  },
};

export const skillCandidateReadTools: ConversationTool[] = [
  listSkillCandidatesTool,
  getSkillCandidateTool,
];
