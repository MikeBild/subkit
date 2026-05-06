// Coverage for the two stop-condition predicates that drive when the
// SDK halts the conversation tool-use loop. Pure inputs/outputs — no
// orchestrator state — so a unit test pins the runtime contract.

import { describe, expect, test } from "bun:test";
import { committedStopCondition, pausedStopCondition } from "../stop-conditions.ts";

describe("committedStopCondition", () => {
  test("returns false on empty step list", () => {
    expect(committedStopCondition({ steps: [] })).toBe(false);
  });

  test("returns false when no save_workflow_draft tool fired", () => {
    expect(
      committedStopCondition({
        steps: [{ toolResults: [{ toolName: "load_skill", output: { ok: true } }] }],
      }),
    ).toBe(false);
  });

  test("returns false when save_workflow_draft fired without committed_workflow_id", () => {
    expect(
      committedStopCondition({
        steps: [
          {
            toolResults: [{ toolName: "save_workflow_draft", output: { draft_id: "abc" } }],
          },
        ],
      }),
    ).toBe(false);
  });

  test("returns true when save_workflow_draft produced committed_workflow_id", () => {
    expect(
      committedStopCondition({
        steps: [
          {
            toolResults: [
              {
                toolName: "save_workflow_draft",
                output: { committed_workflow_id: "wf_abc" },
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  test("only inspects the last step's results", () => {
    expect(
      committedStopCondition({
        steps: [
          {
            toolResults: [
              { toolName: "save_workflow_draft", output: { committed_workflow_id: "wf_old" } },
            ],
          },
          { toolResults: [{ toolName: "load_skill", output: {} }] },
        ],
      }),
    ).toBe(false);
  });
});

describe("pausedStopCondition", () => {
  test("returns false on empty step list", () => {
    expect(pausedStopCondition({ steps: [] })).toBe(false);
  });

  test("returns true when any tool result has a pause payload", () => {
    expect(
      pausedStopCondition({
        steps: [
          {
            toolResults: [
              { output: { ok: true } },
              { output: { pause: { kind: "ask_user_confirm" } } },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  test("returns false when no result has a pause", () => {
    expect(
      pausedStopCondition({
        steps: [{ toolResults: [{ output: { ok: true } }] }],
      }),
    ).toBe(false);
  });

  test("ignores all but the last step", () => {
    expect(
      pausedStopCondition({
        steps: [
          { toolResults: [{ output: { pause: {} } }] },
          { toolResults: [{ output: { ok: true } }] },
        ],
      }),
    ).toBe(false);
  });
});
