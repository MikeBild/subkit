import { describe, expect, test } from "bun:test";
import { BranchStepSchema } from "../../../workflows/types.ts";
import { runBranchStep } from "../branch.ts";

function ctx() {
  return {
    signal: new AbortController().signal,
    started_at: new Date(1_700_000_000_000),
    execution_id: "00000000-0000-0000-0000-000000000099",
  } as unknown as Parameters<typeof runBranchStep>[0]["ctx"];
}

describe("branch · branch_when_unresolved did_you_mean", () => {
  test("emits a warning + did_you_mean when when references an unknown step", async () => {
    const step = BranchStepSchema.parse({
      kind: "branch",
      id: "gate",
      when: "$scope.aproval.outcome = 'approved'",
      then_steps: ["a"],
      else_steps: ["b"],
    });
    const scope = {
      approval: { outcome: "approved" },
    };
    const result = await runBranchStep({ ctx: ctx(), step, scope });
    expect(result.status).toBe("succeeded");
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
