// Coverage for the two stop-condition predicates that drive when the
// SDK halts the conversation tool-use loop. Pure inputs/outputs — no
// orchestrator state — so a unit test pins the runtime contract.

import { describe, expect, test } from "bun:test";
import {
  committedStopCondition,
  MAX_STALLED_REPAIR_PREVIEWS,
  noProgressRepairStopCondition,
  pausedStopCondition,
} from "./stop-conditions.ts";

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

// Build a dry_run_workflow tool result in the real envelope shape:
// `{ ok, data: { requires_repair, classification, judge, warnings } }`
// (see dry-run-workflow.ts buildLifecyclePayload). `missing` is the
// judge's unmet-item set; `warningCodes` are the blocking warning codes.
function dryRunStep(opts: {
  blocked?: boolean;
  missing?: string[];
  warningCodes?: string[];
  verdict?: string;
}): {
  toolResults: Array<{ toolName: string; output: unknown }>;
} {
  const blocked = opts.blocked ?? true;
  const data: Record<string, unknown> = blocked
    ? {
        requires_repair: true,
        classification: "needs_repair",
        ...(opts.missing
          ? { judge: { verdict: opts.verdict ?? "partial", reason: "x", missing: opts.missing } }
          : {}),
        ...(opts.warningCodes ? { warnings: opts.warningCodes.map((code) => ({ code })) } : {}),
      }
    : { classification: "ok" };
  return {
    toolResults: [{ toolName: "dry_run_workflow", output: { ok: !blocked, data } }],
  };
}

describe("noProgressRepairStopCondition", () => {
  test("returns false on empty step list", () => {
    expect(noProgressRepairStopCondition({ steps: [] })).toBe(false);
  });

  test("returns false below the stall cap", () => {
    const steps = Array.from({ length: MAX_STALLED_REPAIR_PREVIEWS - 1 }, () =>
      dryRunStep({ missing: ["project names empty"] }),
    );
    expect(noProgressRepairStopCondition({ steps })).toBe(false);
  });

  test("stops on N identical requires_repair + same missing-set in a row", () => {
    const steps = Array.from({ length: MAX_STALLED_REPAIR_PREVIEWS }, () =>
      dryRunStep({ missing: ["project names empty", "droplet specs absent"] }),
    );
    expect(noProgressRepairStopCondition({ steps })).toBe(true);
  });

  test("missing-set order does not matter (same set, different order, still stalls)", () => {
    const steps = [
      dryRunStep({ missing: ["a", "b"] }),
      dryRunStep({ missing: ["b", "a"] }),
      dryRunStep({ missing: ["a", "b"] }),
    ];
    expect(noProgressRepairStopCondition({ steps })).toBe(true);
  });

  test("does NOT stop when the missing-set shrinks each time (progress)", () => {
    const steps = [
      dryRunStep({ missing: ["a", "b", "c"] }),
      dryRunStep({ missing: ["a", "b"] }),
      dryRunStep({ missing: ["a"] }),
    ];
    expect(noProgressRepairStopCondition({ steps })).toBe(false);
  });

  test("a green preview between blocks resets the streak", () => {
    const steps = [
      dryRunStep({ missing: ["a"] }),
      dryRunStep({ missing: ["a"] }),
      dryRunStep({ blocked: false }), // green — resets
      dryRunStep({ missing: ["a"] }),
    ];
    expect(noProgressRepairStopCondition({ steps })).toBe(false);
  });

  test("a different missing-set mid-run resets, then a fresh stall trips", () => {
    const steps = [
      dryRunStep({ missing: ["a"] }),
      dryRunStep({ missing: ["x"] }), // changed → resets
      dryRunStep({ missing: ["x"] }),
      dryRunStep({ missing: ["x"] }),
    ];
    expect(noProgressRepairStopCondition({ steps })).toBe(true);
  });

  test("keys on blocking warning codes when no judge missing-set is present", () => {
    const steps = Array.from({ length: MAX_STALLED_REPAIR_PREVIEWS }, () =>
      dryRunStep({ warningCodes: ["transform_empty_extraction"] }),
    );
    expect(noProgressRepairStopCondition({ steps })).toBe(true);
  });

  test("changing warning codes is progress and does not stop", () => {
    const steps = [
      dryRunStep({ warningCodes: ["compile_error"] }),
      dryRunStep({ warningCodes: ["transform_empty_extraction"] }),
      dryRunStep({ warningCodes: ["loop_over_unresolved"] }),
    ];
    expect(noProgressRepairStopCondition({ steps })).toBe(false);
  });

  test("non-dry_run tool results between previews do not break a stall", () => {
    const steps = [
      dryRunStep({ missing: ["a"] }),
      { toolResults: [{ toolName: "edit_workflow_patch", output: { ok: true } }] },
      dryRunStep({ missing: ["a"] }),
      { toolResults: [{ toolName: "edit_workflow_patch", output: { ok: true } }] },
      dryRunStep({ missing: ["a"] }),
    ];
    expect(noProgressRepairStopCondition({ steps })).toBe(true);
  });

  test("ignores non-blocking dry_run results (no requires_repair) entirely", () => {
    const steps = Array.from({ length: MAX_STALLED_REPAIR_PREVIEWS + 1 }, () =>
      dryRunStep({ blocked: false }),
    );
    expect(noProgressRepairStopCondition({ steps })).toBe(false);
  });

  test("tolerates a top-level (un-nested) data envelope shape", () => {
    const step = {
      toolResults: [
        {
          toolName: "dry_run_workflow",
          output: {
            requires_repair: true,
            judge: { verdict: "partial", reason: "x", missing: ["a"] },
          },
        },
      ],
    };
    expect(noProgressRepairStopCondition({ steps: [step, step, step] })).toBe(true);
  });
});
