// Cross-component contract test: build_workflow producer ↔ loop consumer.
//
// build_workflow emits `ok:false {error_code:"critic_rejected", details: {repairs}}`.
// The conversation loop scans recent tool calls and re-uses the same shape
// to assemble `prior_failures` for the next LLM turn. Both sides reference
// `CriticRejectedDetailsSchema` from `authoring-critic/types.ts`, but the
// SHAPE coupling can only be regression-tested by running the full
// producer output through the consumer helper.
//
// This test is a journey-level smoke test for the rejected → re-authored
// flow at the contract layer — no DB, no LLM, no full runLoop required.

import { describe, expect, test } from "bun:test";
import { expandPriorFailuresFromToolCalls } from "../authoring-critic/prior-failures.ts";
import type { CriticRejectedDetails } from "../authoring-critic/types.ts";

function makeCriticRejectedToolCallRow(details: CriticRejectedDetails) {
  // Exact shape produced by build_workflow when the critic rejects —
  // see `tools/build-workflow.ts` (the `criticVerdict.passed === false`
  // branch). The loop sees this object verbatim via the
  // `conversation_tool_calls.output` jsonb column.
  return {
    tool: "build_workflow",
    output: {
      ok: false,
      error_code: "critic_rejected",
      message: "LLM critic found N issue(s): …",
      details,
      next_best_actions: ["inspect_workflow_draft", "update_param", "edit_workflow_patch"],
    },
  };
}

describe("authoring-critic — producer/consumer contract", () => {
  test("a rejected build_workflow output expands into one prior_failures row per repair, tagged step_id:critic", () => {
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

  test("malformed details on a critic_rejected row do NOT crash, do NOT inject hints, AND suppress the signal", () => {
    // Producer drift: the loop tolerates the row (fail-open) and
    // ALSO suppresses `priorCriticFail`. A bare escalation with no
    // hint just pushes the model to retry without context — worse
    // than no escalation. Suppression is logged at the source.
    const row = {
      tool: "build_workflow",
      output: {
        ok: false,
        error_code: "critic_rejected",
        details: { wrong_shape: true },
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
      // Critic emits 3 repairs.
      makeCriticRejectedToolCallRow({
        repairs: ["a", "b", "c"],
        rationale: "three",
        gating_reason: "step_count",
      }),
      // Standard rejection adds one more.
      {
        tool: "dry_run_workflow",
        output: { ok: false, error_code: "timeout", message: "step deadline" },
      },
      // Another critic emits 4 more but should clip at 5 total.
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

  test("rows with non-failure output are ignored (no false-positive prior_failures)", () => {
    const rows = [
      { tool: "list_workflows", output: { ok: true, data: { workflows: [] } } },
      { tool: "build_workflow", output: { ok: true, data: { persistence: "draft_only" } } },
    ];
    const r = expandPriorFailuresFromToolCalls(rows);
    expect(r.entries).toHaveLength(0);
    expect(r.hadCriticReject).toBe(false);
  });

  test("critic rejection with empty repairs[] suppresses the priorCriticFail signal", () => {
    // Well-formed verdict but zero repairs (schema permits it). With
    // no hint to inject, the escalation has no content for the next
    // turn — suppress the signal so the router doesn't push to the
    // top tier without a reason the model can act on.
    const row = makeCriticRejectedToolCallRow({
      repairs: [],
      rationale: "empty repairs",
    });
    const r = expandPriorFailuresFromToolCalls([row]);
    expect(r.hadCriticReject).toBe(false);
    expect(r.entries).toHaveLength(0);
  });
});
