import { describe, expect, test } from "bun:test";
import { expandPriorFailuresFromToolCalls } from "../authoring-critic/prior-failures.ts";
import type { CriticRejectedDetails } from "../authoring-critic/types.ts";

function makeCriticRejectedToolCallRow(critic_rejection: CriticRejectedDetails) {
  return {
    tool: "author_workflow",
    output: {
      persistence: "draft_only",
      next_step: "dry_run_workflow",
      critic_rejection,
    },
  };
}

describe("authoring-critic — producer/consumer contract", () => {
  test("a critic_rejection advisory expands into one prior_failures row per repair, tagged step_id:critic", () => {
    const row = makeCriticRejectedToolCallRow({
      repairs: [
        "Move `shape` before `tag` so the downstream transform sees data",
        "Drop the redundant second transform",
        "Add an idempotency_key to the POST step",
      ],
      rationale: "Three semantic issues",
      gating_reason: "step_count",
    });
    const r = expandPriorFailuresFromToolCalls([row]);
    expect(r.hadCriticReject).toBe(true);
    expect(r.entries).toHaveLength(3);
    expect(r.entries.every((e) => e.step_id === "critic")).toBe(true);
    expect(r.entries[0]!.error).toContain("Move `shape`");
  });

  test("malformed critic_rejection advisory does NOT crash, does NOT inject hints, AND suppresses the signal", () => {
    const row = {
      tool: "author_workflow",
      output: {
        persistence: "draft_only",
        critic_rejection: { wrong_shape: true },
      },
    };
    const r = expandPriorFailuresFromToolCalls([row]);
    expect(r.hadCriticReject).toBe(false);
    expect(r.entries).toHaveLength(0);
  });

  test("non-critic rejections are passed through with the standard message format", () => {
    const row = {
      tool: "save_workflow_draft",
      output: {
        ok: false,
        error_code: "credential_required",
        message: "credential not configured",
        next_best_actions: ["ask_user_form"],
      },
    };
    const r = expandPriorFailuresFromToolCalls([row]);
    expect(r.hadCriticReject).toBe(false);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.step_id).toBe("save_workflow_draft");
    expect(r.entries[0]!.error).toContain("credential_required");
    expect(r.entries[0]!.error).toContain("ask_user_form");
  });

  test("mix of critic + standard rejections sums correctly and caps at 5", () => {
    const rows = [
      makeCriticRejectedToolCallRow({
        repairs: ["a", "b", "c"],
        rationale: "three",
        gating_reason: "step_count",
      }),
      {
        tool: "dry_run_workflow",
        output: { ok: false, error_code: "timeout", message: "step deadline" },
      },
      makeCriticRejectedToolCallRow({
        repairs: ["d", "e", "f", "g"],
        rationale: "four more",
        gating_reason: "recent_drift",
      }),
    ];
    const r = expandPriorFailuresFromToolCalls(rows);
    expect(r.hadCriticReject).toBe(true);
    expect(r.entries).toHaveLength(5);
    expect(r.entries.slice(0, 3).every((e) => e.step_id === "critic")).toBe(true);
    expect(r.entries[3]!.step_id).toBe("dry_run_workflow");
    expect(r.entries[4]!.step_id).toBe("critic");
    expect(r.entries[4]!.error).toBe("d");
  });

  test("rows with no advisory and non-failure output are ignored (no false-positive prior_failures)", () => {
    const rows = [
      { tool: "list_workflows", output: { ok: true, data: { workflows: [] } } },
      { tool: "author_workflow", output: { persistence: "draft_only" } },
    ];
    const r = expandPriorFailuresFromToolCalls(rows);
    expect(r.entries).toHaveLength(0);
    expect(r.hadCriticReject).toBe(false);
  });

  test("critic_rejection advisory with empty repairs[] suppresses the priorCriticFail signal", () => {
    const row = makeCriticRejectedToolCallRow({
      repairs: [],
      rationale: "empty repairs",
    });
    const r = expandPriorFailuresFromToolCalls([row]);
    expect(r.hadCriticReject).toBe(false);
    expect(r.entries).toHaveLength(0);
  });
});
