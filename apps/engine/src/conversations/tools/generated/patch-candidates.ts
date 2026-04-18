import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const ListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    status: z.enum(["proposed", "applied", "rejected", "superseded"]).optional(),
  })
  .openapi("ListPatchCandidatesToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetPatchCandidateToolInput");

export const listPatchCandidatesTool: ConversationTool = {
  name: "list_patch_candidates",
  description:
    "List Patch Candidates — LLM-proposed fixes for drifted workflow steps, awaiting approval.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = ListInput.parse(rawArgs);
    const rows = await ctx.engineClient.patchCandidates.list({
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    });
    return {
      ok: true,
      data: {
        candidates: rows.map((p) => ({
          id: p.id,
          status: p.status,
          workflow_id: p.workflow_id,
          classification: p.classification,
          fixture_id: p.fixture_id,
          created_at: p.created_at,
        })),
      },
    };
  },
};

export const getPatchCandidateTool: ConversationTool = {
  name: "get_patch_candidate",
  description: "Fetch a patch candidate with full proposal body and reasoning.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = GetInput.parse(rawArgs);
    const p = await ctx.engineClient.patchCandidates.get(args.id);
    if (!p) return { ok: false, data: { error: "patch_candidate_not_found" } };
    return { ok: true, data: { candidate: p } };
  },
};

export const patchCandidateReadTools: ConversationTool[] = [
  listPatchCandidatesTool,
  getPatchCandidateTool,
];
