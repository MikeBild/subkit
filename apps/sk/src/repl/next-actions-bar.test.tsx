// Unit tests for buildChips in next-actions-bar.tsx.
// Pure function tests — no Ink rendering needed; we test the data
// transformation, not the visual output.

import { describe, expect, test } from "bun:test";
import { buildChips, type NextActionsBarProps } from "./next-actions-bar.tsx";

// ---------------------------------------------------------------------------
// buildChips — known action mapping
// ---------------------------------------------------------------------------

describe("buildChips — known action mapping", () => {
  test("run_workflow maps to R/re-run chip", () => {
    const chips = buildChips({ next_best_actions: ["run_workflow"] });
    expect(chips).toHaveLength(1);
    expect(chips[0]?.key).toBe("R");
    expect(chips[0]?.label).toBe("re-run");
  });

  test("rerun maps to R/re-run chip (alias)", () => {
    const chips = buildChips({ next_best_actions: ["rerun"] });
    expect(chips).toHaveLength(1);
    expect(chips[0]?.key).toBe("R");
  });

  test("diagnose_latest_execution maps to D/diagnose chip", () => {
    const chips = buildChips({ next_best_actions: ["diagnose_latest_execution"] });
    expect(chips[0]?.key).toBe("D");
    expect(chips[0]?.label).toBe("diagnose");
  });

  test("inspect_workflow maps to V/view trace chip", () => {
    const chips = buildChips({ next_best_actions: ["inspect_workflow"] });
    expect(chips[0]?.key).toBe("V");
    expect(chips[0]?.label).toBe("view trace");
  });

  test("inspect_execution_step maps to V/view trace chip", () => {
    const chips = buildChips({ next_best_actions: ["inspect_execution_step"] });
    expect(chips[0]?.key).toBe("V");
    expect(chips[0]?.label).toBe("view trace");
  });

  test("unknown action name is silently ignored", () => {
    const chips = buildChips({ next_best_actions: ["some_unknown_action"] });
    expect(chips).toHaveLength(0);
  });

  test("empty next_best_actions returns empty chip list", () => {
    expect(buildChips({ next_best_actions: [] })).toHaveLength(0);
    expect(buildChips({})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildChips — suggested_command chip
// ---------------------------------------------------------------------------

describe("buildChips — suggested_command chip", () => {
  test("suggested_command appends a / chip", () => {
    const chips = buildChips({ suggested_command: "/workflows run my-wf" });
    expect(chips).toHaveLength(1);
    expect(chips[0]?.key).toBe("/");
    expect(chips[0]?.label).toBe("/workflows run my-wf");
  });

  test("null suggested_command does not add a chip", () => {
    const chips = buildChips({ suggested_command: null });
    expect(chips).toHaveLength(0);
  });

  test("undefined suggested_command does not add a chip", () => {
    const chips = buildChips({});
    expect(chips.some((c) => c.key === "/")).toBe(false);
  });

  test("combines next_best_actions chips with suggested_command", () => {
    const chips = buildChips({
      next_best_actions: ["diagnose_latest_execution"],
      suggested_command: "/workflows run my-wf",
    });
    expect(chips.some((c) => c.key === "D")).toBe(true);
    expect(chips.some((c) => c.key === "/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildChips — dedup of duplicate keys
// ---------------------------------------------------------------------------

describe("buildChips — dedup of duplicate keys", () => {
  test("two actions mapping to the same key produce only one chip", () => {
    // Both run_workflow and rerun map to R
    const chips = buildChips({ next_best_actions: ["run_workflow", "rerun"] });
    const rChips = chips.filter((c) => c.key === "R");
    expect(rChips).toHaveLength(1);
  });

  test("inspect_workflow and inspect_execution_step both map to V — only first wins", () => {
    const chips = buildChips({
      next_best_actions: ["inspect_workflow", "inspect_execution_step"],
    });
    const vChips = chips.filter((c) => c.key === "V");
    expect(vChips).toHaveLength(1);
  });

  test("order is preserved: first seen key wins, subsequent duplicate is dropped", () => {
    // run_workflow (R) then diagnose (D) then another run_workflow (R duplicate)
    const chips = buildChips({
      next_best_actions: ["run_workflow", "diagnose_latest_execution", "rerun"],
    });
    const keys = chips.map((c) => c.key);
    expect(keys).toContain("R");
    expect(keys).toContain("D");
    // R appears exactly once
    expect(keys.filter((k) => k === "R")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildChips — full succession envelope shape
// ---------------------------------------------------------------------------

describe("buildChips — full post-execution envelope", () => {
  test("succeeded execution envelope produces R + V + / chips", () => {
    const props: NextActionsBarProps = {
      next_best_actions: ["inspect_execution_step", "run_workflow"],
      suggested_command: "/workflows run emobxp-jira-test-plans",
    };
    const chips = buildChips(props);
    const keys = chips.map((c) => c.key);
    expect(keys).toContain("R");
    expect(keys).toContain("V");
    expect(keys).toContain("/");
  });

  test("failed execution envelope produces D + V + / chips", () => {
    const props: NextActionsBarProps = {
      next_best_actions: ["diagnose_latest_execution", "inspect_workflow"],
      suggested_command: "/workflows run emobxp-jira-test-plans",
    };
    const chips = buildChips(props);
    const keys = chips.map((c) => c.key);
    expect(keys).toContain("D");
    expect(keys).toContain("V");
    expect(keys).toContain("/");
  });
});
