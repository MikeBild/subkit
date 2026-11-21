import { describe, expect, test } from "bun:test";
import {
  expectedMutationScope,
  MUTATION_GLOBS,
  mutationGlobsMatch,
  PURE_MUTATION_TARGETS,
} from "../audit/mutation-scope.ts";
import { pureTargetPaths } from "../audit/pure-targets.ts";

describe("pure mutation scope", () => {
  test("includes engine cores and the explicit cross-application pure manifest only", () => {
    expect(
      expectedMutationScope([
        "apps/engine/src/workflows/core/workflow.ts",
        "apps/engine/src/workflows/service.ts",
        "apps/cockpit/src/features/audit/model/audit-filter-state.ts",
        "apps/sk/src/domain/agent/agent-file.ts",
        "packages/shared/src/approval-choice.ts",
        "packages/shared/src/jsonl-ring.ts",
      ]),
    ).toEqual([
      "apps/cockpit/src/features/audit/model/audit-filter-state.ts",
      "apps/engine/src/workflows/core/workflow.ts",
      "apps/sk/src/domain/agent/agent-file.ts",
      "packages/shared/src/approval-choice.ts",
    ]);
  });

  test("keeps the Stryker configuration pinned to the reviewed manifest", () => {
    expect(mutationGlobsMatch(MUTATION_GLOBS)).toBe(true);
    expect(mutationGlobsMatch([...MUTATION_GLOBS, "packages/shared/src/jsonl-ring.ts"])).toBe(
      false,
    );
    expect(PURE_MUTATION_TARGETS).not.toContain("packages/shared/src/jsonl-ring.ts");
  });

  test("derives the mutation scope from the same canonical discovery output", () => {
    const files = [
      "apps/engine/src/workflows/core/workflow.ts",
      "apps/cockpit/src/features/audit/model/audit-labels.ts",
    ];
    expect(expectedMutationScope(files)).toEqual(pureTargetPaths(files));
  });
});
