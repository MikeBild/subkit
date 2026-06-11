// Pure-function tests for the turn-level loop budget stop condition and
// the empty-text fallback synthesizer. No DB / no provider — these
// helpers are the critical safety net when the model loops, so they
// must be deterministic and covered.

import { describe, expect, test } from "bun:test";
import { synthesizeFallbackMessage, turnLoopBudgetStopCondition } from "../turn-helpers.ts";
import type { TurnEvent } from "../types.ts";

describe("turnLoopBudgetStopCondition", () => {
  test("no steps → does not stop", () => {
    expect(turnLoopBudgetStopCondition({ steps: [] })).toBe(false);
  });

  test("last step has a normal tool result → does not stop", () => {
    expect(
      turnLoopBudgetStopCondition({
        steps: [
          {
            toolResults: [{ output: { ok: true, data: { workflows: [] } } }],
          },
        ],
      }),
    ).toBe(false);
  });

  test("last step carries tool_loop_detected (single-tool cap) → does not stop the turn", () => {
    expect(
      turnLoopBudgetStopCondition({
        steps: [
          {
            toolResults: [
              {
                output: {
                  ok: false,
                  data: { reason: "tool_loop_detected", tool: "list_workflows" },
                },
              },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  test("last step carries turn_loop_budget_exhausted → stops", () => {
    expect(
      turnLoopBudgetStopCondition({
        steps: [
          {
            toolResults: [
              {
                output: {
                  ok: false,
                  data: {
                    reason: "turn_loop_budget_exhausted",
                    tool: "list_workflows",
                  },
                },
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  test("exhausted reason in mixed results → stops as long as one carries it", () => {
    expect(
      turnLoopBudgetStopCondition({
        steps: [
          {
            toolResults: [
              { output: { ok: true, data: { workflows: [] } } },
              {
                output: {
                  ok: false,
                  data: { reason: "turn_loop_budget_exhausted" },
                },
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("synthesizeFallbackMessage", () => {
  test("no tool_result events and no loop warnings → null (callers render silence)", () => {
    expect(synthesizeFallbackMessage({ events: [], loopWarnings: 0 })).toBeNull();
  });

  test("no tool results but loop fired → generic loop-apology", () => {
    const msg = synthesizeFallbackMessage({ events: [], loopWarnings: 2 });
    expect(msg).toContain("kept hitting the same call");
    expect(msg).toContain("Try rephrasing");
  });

  test("summarises the latest tool_result per tool when no text was produced", () => {
    const events: TurnEvent[] = [
      {
        type: "tool_result",
        call_id: "c1",
        tool: "list_workflows",
        output: { workflows: [{ id: "w1" }, { id: "w2" }, { id: "w3" }] },
      },
      {
        type: "tool_result",
        call_id: "c2",
        tool: "list_connectors",
        output: { connectors: [{ id: "c1" }] },
      },
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg).toContain("list_workflows: 3 entries");
    expect(msg).toContain("list_connectors: 1 entries");
    expect(msg).toContain("Summary of the latest tool results:");
  });

  test("loop-aware header when loopWarnings > 0", () => {
    const events: TurnEvent[] = [
      {
        type: "tool_result",
        call_id: "c1",
        tool: "list_workflows",
        output: { workflows: [] },
      },
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 2 });
    expect(msg).toContain("stopped this turn early");
    expect(msg).toContain("list_workflows: 0 entries");
  });

  test("falls back to reason / error / field list when no array summary fits", () => {
    const events: TurnEvent[] = [
      {
        type: "tool_result",
        call_id: "c1",
        tool: "save_connector_draft",
        output: { ok: false, reason: "validation_failed" },
      },
      {
        type: "tool_result",
        call_id: "c2",
        tool: "probe_connector",
        output: { error: "http_401" },
      },
      {
        type: "tool_result",
        call_id: "c3",
        tool: "whoami",
        output: { user_id: "u1", tenant_id: "t1", role: "admin" },
      },
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg).toContain("save_connector_draft: note: validation_failed");
    expect(msg).toContain("probe_connector: error: http_401");
    expect(msg).toContain("whoami: fields: user_id, tenant_id, role");
  });

  test("ran-the-same-tool-N-times header when the loop fired but every call succeeded", () => {
    // Session d34e5858 regression: "starte mit übermorgen" → 5 parallel
    // run_workflow calls, all succeeded, the loop guard fired, the old
    // fallback claimed "I stopped this turn early" — misleading,
    // because every call actually completed. The fan-out branch should
    // surface the real shape instead.
    const events: TurnEvent[] = Array.from({ length: 5 }).map((_, i) => ({
      type: "tool_result" as const,
      call_id: `c${i}`,
      tool: "run_workflow",
      output: {
        status: "succeeded",
        execution_id: `exec-${i}`,
        workflow_version: 4,
      },
    }));
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 2 });
    expect(msg).toContain("ran the same tool 5 times");
    expect(msg).toContain("all succeeded");
    expect(msg).toContain("run_workflow");
    expect(msg).toContain("(called 5×)");
    expect(msg).not.toContain("stopped this turn early");
  });

  test("keeps only the latest output per tool name", () => {
    const events: TurnEvent[] = [
      {
        type: "tool_result",
        call_id: "c1",
        tool: "list_workflows",
        output: { workflows: [{ id: "w1" }] },
      },
      {
        type: "tool_result",
        call_id: "c2",
        tool: "list_workflows",
        output: { workflows: [{ id: "w1" }, { id: "w2" }] },
      },
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg).toContain("list_workflows: 2 entries");
    // Earlier single-entry line must not leak in.
    expect(msg).not.toContain("1 entries");
  });
});

// RC3(b) — the synthesized empty-turn fallback is operator-facing prose.
// Forensic root cause (conversation 68b5c87e): two turns ended with the
// synthesized text "ask_user_form: error_code: credential_form_mismatch"
// — a raw machine token shown to a human. Failed tool results must
// render their hint/message prose plus the corrective detail
// (missing / expected_fields / setup_instructions) and NEVER the bare
// `error_code:` token.
describe("synthesizeFallbackMessage — error envelopes render as prose", () => {
  test("failed result with message + missing + expected_fields → prose with corrective detail", () => {
    const events: TurnEvent[] = [
      {
        type: "tool_result",
        call_id: "c1",
        tool: "ask_user_form",
        output: {
          error_code: "credential_form_mismatch",
          message:
            "bearer credentials are collected with fields named exactly [token] — rename your fields (labels stay free-form).",
          missing: ["token"],
          expected_fields: ["token"],
        },
      },
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg).not.toBeNull();
    expect(msg ?? "").not.toContain("error_code:");
    expect(msg ?? "").toContain("fields named exactly [token]");
    expect(msg ?? "").toContain("missing: token");
    expect(msg ?? "").toContain("expected fields: token");
  });

  test("failed result with only error_code → humanised prose, never the raw token", () => {
    const events: TurnEvent[] = [
      {
        type: "tool_result",
        call_id: "c1",
        tool: "ask_user_form",
        output: { error_code: "credential_form_mismatch", missing: ["token"] },
      },
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg).not.toBeNull();
    expect(msg ?? "").not.toContain("error_code:");
    expect(msg ?? "").not.toContain("credential_form_mismatch");
    expect(msg ?? "").toContain("credential form mismatch");
    expect(msg ?? "").toContain("missing: token");
  });

  test("setup_instructions hint from the failed result reaches the prose", () => {
    const events: TurnEvent[] = [
      {
        type: "tool_result",
        call_id: "c1",
        tool: "ask_user_form",
        output: {
          error_code: "credential_form_mismatch",
          message: "bearer credentials are collected with fields named exactly [token].",
          expected_fields: ["token"],
          setup_instructions: "Create an API key under Settings → API Keys.",
        },
      },
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg ?? "").toContain("Settings → API Keys");
    expect(msg ?? "").not.toContain("error_code:");
  });

  test("nested data envelope (error_code at top, detail under data) is also rendered as prose", () => {
    const events: TurnEvent[] = [
      {
        type: "tool_result",
        call_id: "c1",
        tool: "ask_user_form",
        output: {
          ok: false,
          error_code: "credential_form_mismatch",
          data: {
            error_code: "credential_form_mismatch",
            message: "header credentials need header_name and header_value.",
            missing: ["header_value"],
            expected_fields: ["header_name", "header_value"],
          },
        },
      },
    ];
    const msg = synthesizeFallbackMessage({ events, loopWarnings: 0 });
    expect(msg ?? "").not.toContain("error_code:");
    expect(msg ?? "").toContain("header_name and header_value");
    expect(msg ?? "").toContain("missing: header_value");
  });
});
