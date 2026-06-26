// Coverage for `tallyRepairSignals` — the run_workflow circuit-breaker
// tally. The original breaker only counted authoring-bug WARNING codes;
// a runaway authoring session that kept producing the SAME runtime
// execution failure (e.g. 14× GET /v1/pages/<a-human-name> → http 400)
// carried no warning code, slipped past the breaker, and burned the
// whole step budget. These tests pin the runtime-failure tally and prove
// the warning-code path is unchanged.

import { describe, expect, test } from "bun:test";
import {
  REPAIR_LOOP_TRIP_THRESHOLD,
  type RepairSignalRow,
  tallyRepairSignals,
} from "../generated/writes/repair-loop-tally.ts";

/** A `run_workflow` row whose execution FAILED at `step` with `code`. */
function failedExec(step: string, code: string): RepairSignalRow {
  return {
    tool: "run_workflow",
    output: {
      data: {
        status: "failed",
        failure_step_key: step,
        step_trace: [{ step_id: step, status: "failed", error_code: code }],
      },
    },
  };
}

/** A `run_workflow` row that surfaced an authoring-bug warning code. */
function warned(code: string): RepairSignalRow {
  return { tool: "run_workflow", output: { data: { warnings: [{ code }] } } };
}

describe("tallyRepairSignals — runtime execution failures (Fix B)", () => {
  test("threshold is 3", () => {
    expect(REPAIR_LOOP_TRIP_THRESHOLD).toBe(3);
  });

  test("trips on 3 identical runtime failures (the Notion-by-name 400 spiral)", () => {
    const rows = [
      failedExec("page", "http_4xx"),
      failedExec("page", "http_4xx"),
      failedExec("page", "http_4xx"),
    ];
    const v = tallyRepairSignals(rows);
    expect(v.tripped).toBe(true);
    expect(v.tripped_codes).toEqual([{ code: "exec_failed:page:http_4xx", count: 3 }]);
  });

  test("does NOT trip on only 2 identical runtime failures", () => {
    const v = tallyRepairSignals([failedExec("page", "http_4xx"), failedExec("page", "http_4xx")]);
    expect(v.tripped).toBe(false);
    expect(v.tripped_codes).toEqual([]);
  });

  test("different failing steps do NOT pile into the same bucket", () => {
    // 2× at `page` + 1× at `blocks` — no single key reaches 3.
    const v = tallyRepairSignals([
      failedExec("page", "http_4xx"),
      failedExec("page", "http_4xx"),
      failedExec("blocks", "http_4xx"),
    ]);
    expect(v.tripped).toBe(false);
  });

  test("different error codes at the same step do NOT pile together", () => {
    const v = tallyRepairSignals([
      failedExec("page", "http_4xx"),
      failedExec("page", "http_5xx"),
      failedExec("page", "http_4xx"),
    ]);
    expect(v.tripped).toBe(false);
  });

  test("falls back to exec_error when the failed step carries no error_code", () => {
    const noCode: RepairSignalRow = {
      tool: "run_workflow",
      output: { data: { status: "failed", failure_step_key: "page", step_trace: [] } },
    };
    const v = tallyRepairSignals([noCode, noCode, noCode]);
    expect(v.tripped).toBe(true);
    expect(v.tripped_codes).toEqual([{ code: "exec_failed:page:exec_error", count: 3 }]);
  });

  test("ignores rows from other tools", () => {
    const other: RepairSignalRow = {
      tool: "inspect_workflow",
      output: { data: { status: "failed", failure_step_key: "page", step_trace: [] } },
    };
    const v = tallyRepairSignals([other, other, other]);
    expect(v.tripped).toBe(false);
  });

  test("a succeeding run does not count toward the failure tally", () => {
    const ok: RepairSignalRow = { tool: "run_workflow", output: { data: { status: "succeeded" } } };
    const v = tallyRepairSignals([
      failedExec("page", "http_4xx"),
      ok,
      failedExec("page", "http_4xx"),
      ok,
      failedExec("page", "http_4xx"),
    ]);
    // 3 real failures still trip even when interleaved with successes.
    expect(v.tripped).toBe(true);
    expect(v.tripped_codes).toEqual([{ code: "exec_failed:page:http_4xx", count: 3 }]);
  });
});

describe("tallyRepairSignals — authoring-bug warning path (unchanged)", () => {
  test("trips on 3 repeating unresolved_identifier warnings", () => {
    const v = tallyRepairSignals([
      warned("unresolved_identifier"),
      warned("unresolved_identifier"),
      warned("unresolved_identifier"),
    ]);
    expect(v.tripped).toBe(true);
    expect(v.tripped_codes).toEqual([{ code: "unresolved_identifier", count: 3 }]);
  });

  test("a non-repeating warning code never trips", () => {
    const v = tallyRepairSignals([
      warned("transform_dropped_fields"),
      warned("transform_dropped_fields"),
      warned("transform_dropped_fields"),
    ]);
    expect(v.tripped).toBe(false);
  });
});
