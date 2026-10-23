import { describe, expect, test } from "bun:test";
import { buildPendingOutputForTool } from "../../../tool-policies.ts";
import type { ToolContext } from "../../index.ts";
import {
  type ApproveBatchDeps,
  approveCandidateIds,
  approveSkillCandidates,
  approveSkillCandidateTool,
} from "./candidates.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function harness(
  state: Record<string, "proposed" | "approved" | "missing" | "changed">,
  denied: string[] = [],
) {
  const audits: Array<{ resource_id: string; result: string; reason?: string }> = [];
  const approveCalls: Array<{ candidate_id: string; digest: string | undefined }> = [];
  const ctx = {
    tenant_id: "t",
    conversation_id: "c",
    actor_id: null,
    db: {},
    engineClient: {
      audit_write: async (entry: { resource_id: string; result: string; reason?: string }) => {
        audits.push({
          resource_id: entry.resource_id,
          result: entry.result,
          ...(entry.reason ? { reason: entry.reason } : {}),
        });
      },
    },
  } as unknown as ToolContext;
  const deps: ApproveBatchDeps = {
    approve: (async (p: { candidate_id: string; expected_review_digest?: string }) => {
      approveCalls.push({ candidate_id: p.candidate_id, digest: p.expected_review_digest });
      if (state[p.candidate_id] !== "proposed") return null;
      state[p.candidate_id] = "approved";
      return {
        candidate: { id: p.candidate_id, title: `Title ${p.candidate_id.slice(-1)}` },
        skill_id: `skill-${p.candidate_id.slice(-1)}`,
      };
    }) as unknown as ApproveBatchDeps["approve"],
    current: (async (_tenant: string, id: string) => {
      const status = state[id];
      if (!status || status === "missing") return null;
      return {
        id,
        pattern_kind: "success_pattern",
        status: status === "changed" ? "proposed" : status,
      };
    }) as unknown as ApproveBatchDeps["current"],
    permit: (async (_ctx: ToolContext, _perm: string, resource: { id: string }) =>
      denied.includes(resource.id)
        ? { allow: false, permission: "skill:write", reason: "role lacks skill:write" }
        : { allow: true }) as unknown as ApproveBatchDeps["permit"],
  };
  return { ctx, deps, audits, approveCalls };
}

describe("approve_skill_candidate batches", () => {
  test("the input takes a list or a single id and refuses neither", () => {
    const schema = approveSkillCandidateTool.inputSchema;
    expect(schema.safeParse({ candidate_ids: [A, B] }).success).toBe(true);
    expect(schema.safeParse({ candidate_id: A }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ candidate_ids: [] }).success).toBe(false);
    expect(schema.safeParse({ candidate_ids: Array.from({ length: 101 }, () => A) }).success).toBe(
      false,
    );
    expect(approveCandidateIds({ candidate_ids: [A, B, A], candidate_id: B })).toEqual([A, B]);
  });

  test("one confirmation summary covers the whole batch", () => {
    expect(
      buildPendingOutputForTool("approve_skill_candidate", { candidate_ids: [A, B, A] }),
    ).toEqual({ candidate_count: 2, candidate_ids: [A, B] });
    expect(buildPendingOutputForTool("approve_skill_candidate", { candidate_id: A })).toEqual({
      candidate_id: A,
    });
  });

  test("each candidate is approved with its own reviewed digest and audited on its own", async () => {
    const h = harness({ [A]: "proposed", [B]: "proposed" });
    const result = await approveSkillCandidates(
      h.ctx,
      { candidate_ids: [A, B], expected_review_digests: { [A]: DIGEST_A, [B]: DIGEST_B } },
      h.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      approved: 2,
      results: [
        { candidate_id: A, outcome: "approved", skill_id: "skill-a" },
        { candidate_id: B, outcome: "approved", skill_id: "skill-b" },
      ],
      skill_status: "draft",
      activation_required: true,
    });
    expect(h.approveCalls).toEqual([
      { candidate_id: A, digest: DIGEST_A },
      { candidate_id: B, digest: DIGEST_B },
    ]);
    expect(h.audits).toEqual([
      { resource_id: A, result: "success" },
      { resource_id: B, result: "success" },
    ]);
  });

  test("a changed or decided candidate reports its own outcome while the rest are approved", async () => {
    const h = harness({ [A]: "proposed", [B]: "changed", [C]: "approved" });
    const result = await approveSkillCandidates(h.ctx, { candidate_ids: [A, B, C] }, h.deps);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      approved: 1,
      changed_since_review: 1,
      already_decided: 1,
      results: [
        { candidate_id: A, outcome: "approved" },
        { candidate_id: B, outcome: "changed_since_review" },
        { candidate_id: C, outcome: "already_decided" },
      ],
    });
    expect(h.audits).toEqual([
      { resource_id: A, result: "success" },
      { resource_id: B, result: "error", reason: "changed_since_review" },
      { resource_id: C, result: "error", reason: "already_decided" },
    ]);
  });

  test("a batch where nothing was approved fails and says so", async () => {
    const h = harness({ [A]: "missing", [B]: "approved" });
    const result = await approveSkillCandidates(h.ctx, { candidate_ids: [A, B] }, h.deps);
    expect(result).toMatchObject({
      ok: false,
      error_code: "not_found",
      next_best_actions: ["list_skill_candidates"],
    });
  });

  test("a single id keeps the single result shape", async () => {
    const h = harness({ [A]: "proposed" });
    const result = await approveSkillCandidates(
      h.ctx,
      { candidate_id: A, expected_review_digest: DIGEST_A },
      h.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ skill_id: "skill-a", skill_status: "draft" });
    expect(h.approveCalls).toEqual([{ candidate_id: A, digest: DIGEST_A }]);
  });

  test("a single legacy digest never binds a batch", async () => {
    const h = harness({ [A]: "proposed", [B]: "proposed" });
    await approveSkillCandidates(
      h.ctx,
      { candidate_ids: [A, B], expected_review_digest: DIGEST_A },
      h.deps,
    );
    expect(h.approveCalls.map((call) => call.digest)).toEqual([undefined, undefined]);
  });

  test("a missing permission on any candidate approves nothing", async () => {
    const h = harness({ [A]: "proposed", [B]: "proposed" }, [B]);
    const result = await approveSkillCandidates(h.ctx, { candidate_ids: [A, B] }, h.deps);
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ error: "permission_denied" });
    expect(h.approveCalls).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});
