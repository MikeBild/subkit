// Runtime did_you_mean — when an expression resolves to undefined,
// the loop / branch driver should surface a typed warning carrying
// (a) the typo'd reference, (b) the closest match by Levenshtein,
// and (c) the available scope keys so the LLM can fix the path on
// the next attempt.

import { describe, expect, test } from "bun:test";
import { BranchStepSchema, LoopStepSchema } from "../../../workflows/types.ts";
import { runBranchStep } from "../branch.ts";
import { runLoopStep } from "../loop.ts";

function ctx() {
  // Stub abort signal + the execution fields the data_selector path threads
  // into the sandbox clock (`started_at` / `execution_id`).
  return {
    signal: new AbortController().signal,
    started_at: new Date(1_700_000_000_000),
    execution_id: "00000000-0000-0000-0000-000000000099",
  } as unknown as Parameters<typeof runLoopStep>[0]["ctx"];
}

describe("loop · loop_over_unresolved did_you_mean", () => {
  test("flags a near-typo and suggests the closest scope key", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "iter",
      // typo: fetch_projets vs. fetch_projects (the actual key)
      over: "$scope.fetch_projets.data.projects",
      body: ["downstream"],
    });
    const scope = {
      fetch_projects: { data: { projects: [1, 2, 3] } },
    };
    const result = await runLoopStep({ ctx: ctx(), step, scope });
    // Loop with broken `over` succeeds with output=[] and emits the
    // typed warning — the LLM reads details.did_you_mean to fix.
    expect(result.status).toBe("succeeded");
    expect(result.warnings?.[0]?.code).toBe("loop_over_unresolved");
    const details = result.warnings?.[0]?.details as Record<string, unknown>;
    expect(details.did_you_mean).toEqual([{ from: "fetch_projets", to: ["fetch_projects"] }]);
    expect(details.suggested_paths).toEqual(["$scope.fetch_projects.data", "fetch_projects.data"]);
  });

  test("falls back to first scope key when no near-match exists", async () => {
    const step = LoopStepSchema.parse({
      kind: "loop",
      id: "iter",
      over: "$scope.totally_different.data",
      body: ["x"],
    });
    const scope = {
      api_response: { data: [1, 2] },
    };
    const result = await runLoopStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("succeeded");
    const w = result.warnings?.[0];
    expect(w?.code).toBe("loop_over_unresolved");
    expect((w!.details as Record<string, unknown>).did_you_mean).toBeUndefined();
    // Hint message still references a concrete scope key.
    expect(w?.message).toContain("api_response");
  });
});

describe("branch · branch_when_unresolved did_you_mean", () => {
  test("emits a warning + did_you_mean when when references an unknown step", async () => {
    const step = BranchStepSchema.parse({
      kind: "branch",
      id: "gate",
      // typo: aproval vs. approval
      when: "$scope.aproval.outcome = 'approved'",
      then_steps: ["a"],
      else_steps: ["b"],
    });
    const scope = {
      approval: { outcome: "approved" },
    };
    const result = await runBranchStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("succeeded");
    // Picks else because matched=undefined → falsy.
    expect((result.output as { arm?: string }).arm).toBe("else");
    const w = result.warnings?.[0];
    expect(w?.code).toBe("branch_when_unresolved");
    const details = w?.details as Record<string, unknown>;
    expect(details.did_you_mean).toEqual([{ from: "aproval", to: ["approval"] }]);
  });

  test("no warning when the expression resolves cleanly", async () => {
    const step = BranchStepSchema.parse({
      kind: "branch",
      id: "gate",
      when: "$scope.approval.outcome = 'approved'",
      then_steps: ["a"],
      else_steps: ["b"],
    });
    const scope = {
      approval: { outcome: "approved" },
    };
    const result = await runBranchStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("succeeded");
    expect(result.warnings).toBeUndefined();
    expect((result.output as { arm?: string }).arm).toBe("then");
  });
});
