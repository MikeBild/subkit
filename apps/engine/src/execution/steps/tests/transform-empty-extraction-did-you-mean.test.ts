// transform_empty_extraction now carries did_you_mean — same shape
// as loop_over_unresolved / branch_when_unresolved. The LLM reads
// details.did_you_mean to fix the path on the next attempt.

import { describe, expect, test } from "bun:test";
import { TransformStepSchema } from "../../../workflows/types.ts";
import { runTransformStep } from "../transform.ts";

function ctx() {
  return { signal: new AbortController().signal } as unknown as Parameters<
    typeof runTransformStep
  >[0]["ctx"];
}

describe("transform · transform_empty_extraction did_you_mean", () => {
  test("typo'd $scope ref produces did_you_mean", async () => {
    const step = TransformStepSchema.parse({
      kind: "transform",
      id: "shape",
      // typo: fetch_projets vs. fetch_projects (the actual scope key)
      expression: "$scope.fetch_projets.data.projects",
    });
    const scope = {
      fetch_projects: { data: { projects: [{ id: 1 }, { id: 2 }] } },
    };
    const result = await runTransformStep({ ctx: ctx(), step, scope, input: null });
    expect(result.status).toBe("succeeded");
    const w = result.warnings?.find((x) => x.code === "transform_empty_extraction");
    expect(w).toBeDefined();
    const details = w?.details as Record<string, unknown>;
    expect(details.did_you_mean).toEqual([{ from: "fetch_projets", to: ["fetch_projects"] }]);
  });
});
