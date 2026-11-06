import { describe, expect, test } from "bun:test";
import { selectCoreTests } from "../audit/core-tests.ts";

describe("selectCoreTests", () => {
  test("keeps engine core tests and every shared test, sorted and unique", () => {
    expect(
      selectCoreTests([
        "packages/shared/src/approval-choice.test.ts",
        "apps/engine/src/execution/core/status.test.ts",
        "apps/engine/src/conversations/core/nested/draft.test.ts",
        "apps/engine/src/workflows/core.test.ts",
        "packages/shared/src/tests/redaction.test.ts",
        "apps/engine/src/workflows/core.test.ts",
      ]),
    ).toEqual([
      "apps/engine/src/conversations/core/nested/draft.test.ts",
      "apps/engine/src/execution/core/status.test.ts",
      "apps/engine/src/workflows/core.test.ts",
      "packages/shared/src/approval-choice.test.ts",
      "packages/shared/src/tests/redaction.test.ts",
    ]);
  });

  test("drops look-alikes and other packages", () => {
    expect(
      selectCoreTests([
        "apps/engine/src/scoring/score.test.ts",
        "apps/engine/src/x/hardcore.test.ts",
        "apps/engine/src/x/core.test.tsx",
        "packages/cli-core/src/core.test.ts",
        "apps/sk/src/core/x.test.ts",
        "packages/shared/node_modules/x/src/a.test.ts",
        "packages/shared/src/approval-choice.ts",
      ]),
    ).toEqual([]);
  });
});
