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
