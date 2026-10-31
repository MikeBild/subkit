import { describe, expect, test } from "bun:test";
import { pairConfirmedRunResults } from "./confirmed-run-result.ts";

const card = (id: string) => ({
  id,
  tool: "run_workflow",
  input: { workflow: "send" },
  output: { status: "resolved" },
  outcome: "error",
});
const result = (id: string, outcome: string) => ({
  id,
  tool: "run_workflow",
  input: { _harness_auto_persist: true },
  output: { ok: outcome === "ok" },
  outcome,
});

describe("pairConfirmedRunResults", () => {
  test("each confirmed card gets the run result that followed it", () => {
    const pairs = pairConfirmedRunResults(
      [card("a"), result("ra", "error"), card("b"), result("rb", "ok")],
      () => true,
    );
    expect(pairs.get("a")?.id).toBe("ra");
    expect(pairs.get("b")?.id).toBe("rb");
  });

  test("declined cards and other tools stay unpaired", () => {
    const pairs = pairConfirmedRunResults(
      [card("a"), { ...result("x", "ok"), tool: "save_workflow_draft" }, result("ra", "ok")],
      () => false,
    );
    expect(pairs.size).toBe(0);
  });
});
