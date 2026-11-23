import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const ListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    status: z.enum(["proposed", "applied", "rejected", "superseded", "inapplicable"]).optional(),
  })
  .openapi("ListPatchCandidatesToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetPatchCandidateToolInput");
const DryRunInput = z
  .object({
    id: z.string().uuid(),
    accepted_operations: z
      .array(z.number().int().min(0))
      .min(1)
      .optional()
      .describe(
        "Indices from the preview's `operations` list to test on their own; omit to test the whole repair",
      ),
  })
  .openapi("DryRunPatchCandidateToolInput");

const listPatchCandidatesTool: ConversationTool = {
  name: "list_patch_candidates",
  description:
    "List Patch Candidates — LLM-proposed fixes for drifted workflow steps. open_total counts the ones a human can decide now; review_reason says why a proposed one cannot be.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof ListInput>) {
    const [rows, open] = await Promise.all([
      ctx.engineClient.patchCandidates.list({
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
      }),
      ctx.engineClient.patchCandidates.openDecisions(),
    ]);
    return {
      ok: true,
      data: {
        open_total: open.open_total,
        candidates: rows.map((p) => ({
          id: p.id,
          status: p.status,
          workflow_id: p.workflow_id,
          classification: p.classification,
          fixture_id: p.fixture_id,
          reviewable: p.reviewable,
          review_reason: p.review_reason,
          created_at: p.created_at,
        })),
      },
    };
  },
};

const getPatchCandidateTool: ConversationTool = {
  name: "get_patch_candidate",
  description:
    "Fetch a patch candidate with full proposal body and reasoning. interaction_log lists what a person already tested, accepted partly or declined.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof GetInput>) {
    const p = await ctx.engineClient.patchCandidates.get(args.id);
    if (!p) return { ok: false, data: { error: "patch_candidate_not_found" } };
    return {
      ok: true,
      data: {
        candidate: p,
        interaction_log: await ctx.engineClient.patchCandidates.interactionLog(args.id),
      },
    };
  },
};

const previewPatchCandidateTool: ConversationTool = {
  name: "preview_patch_candidate",
  description:
    "Human-readable before/after preview of a patch candidate: the affected step's current shape, the patched shape, which paths change, and `operations` — the single changes a person can accept one by one. Show this to the user BEFORE asking them to approve.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof GetInput>) {
    const preview = await ctx.engineClient.patchCandidates.preview(args.id);
    if (!preview) return { ok: false, data: { error: "patch_candidate_not_found" } };
    return { ok: true, data: { preview } };
  },
};

const dryRunPatchCandidateTool: ConversationTool = {
  name: "dry_run_patch_candidate",
  description:
    "Replay a patch candidate against a recorded (or synthesized) execution fixture WITHOUT applying it. Use to verify the patch projects cleanly before approval. With `accepted_operations` it tests only those changes and returns the `review_digest` that approving exactly this part needs. Never changes the workflow.",
  inputSchema: DryRunInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof DryRunInput>) {
    const outcome = await ctx.engineClient.patchCandidates.dryRun(
      args.id,
      args.accepted_operations,
    );
    if (outcome.status === "not_found") {
      return { ok: false, data: { error: "patch_candidate_not_found" } };
    }
    if (outcome.status === "invalid_selection") {
      return {
        ok: false,
        data: {
          error: outcome.reason,
          hint: "pass indices from the `operations` list of preview_patch_candidate",
        },
      };
    }
    if (outcome.status !== "ran") {
      return {
        ok: false,
        data: {
          error: outcome.status,
          hint:
            outcome.status === "gate_fix"
              ? "a gate repair has no fixture replay: its proof is a held preparation run of the prepared version — preview it and let the person prepare and approve it"
              : "no replayable step/fixture material — run the workflow once so the engine captures a fixture, then retry",
        },
      };
    }
    return {
      ok: true,
      data: {
        ok: outcome.ok,
        error: outcome.error,
        value_preview: outcome.value_preview,
        fixture_source: outcome.fixture_source,
        accepted_operations: outcome.accepted_operations,
        review_digest: outcome.review_digest,
      },
    };
  },
};

export const patchCandidateReadTools: ConversationTool[] = [
  listPatchCandidatesTool,
  getPatchCandidateTool,
  previewPatchCandidateTool,
  dryRunPatchCandidateTool,
];
