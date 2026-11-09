import { describe, expect, test } from "bun:test";
import {
  orderShardTests,
  parseShardArgs,
  runShardTests,
  selectCanonicalCoreTests,
  selectCoreTests,
} from "../audit/core-tests.ts";

describe("selectCoreTests", () => {
  test("keeps engine core, reviewed pure and shared tests, sorted and unique", () => {
    expect(
      selectCoreTests([
        "packages/shared/src/approval-choice.test.ts",
        "apps/engine/src/execution/core/status.test.ts",
        "apps/engine/src/conversations/core/nested/draft.test.ts",
        "apps/engine/src/workflows/core.test.ts",
        "apps/cockpit/src/pages/audit-filter-state.test.ts",
        "apps/sk/src/domain/agent/agent-file.test.ts",
        "packages/shared/src/tests/redaction.test.ts",
        "apps/engine/src/workflows/core.test.ts",
      ]),
    ).toEqual([
      "apps/cockpit/src/pages/audit-filter-state.test.ts",
      "apps/engine/src/conversations/core/nested/draft.test.ts",
      "apps/engine/src/execution/core/status.test.ts",
      "apps/engine/src/workflows/core.test.ts",
      "apps/sk/src/domain/agent/agent-file.test.ts",
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

test("orders manifest direct witnesses first without narrowing the reviewed test set", async () => {
  const paths = [
    "z.test.ts",
    "packages/cli-core/src/format-render.test.ts",
    "a.test.ts",
    "direct.test.ts",
  ];
  const ordered = orderShardTests(paths, ["direct.test.ts", "a.test.ts"]);
  expect(ordered).toEqual([
    "a.test.ts",
    "direct.test.ts",
    "packages/cli-core/src/format-render.test.ts",
    "z.test.ts",
  ]);
  expect([...ordered].sort()).toEqual([...paths].sort());
  const seen: string[] = [];
  await expect(
    runShardTests(
      ["a.test.ts", "b.test.ts", "direct.test.ts"],
      async (path) => {
        seen.push(path);
        if (path === "direct.test.ts") throw new Error("fail");
      },
      false,
      ["direct.test.ts"],
    ),
  ).rejects.toThrow("fail");
  expect(seen).toEqual(["direct.test.ts"]);
});

test("full closure preserves the same complete set after a prioritized failure", async () => {
  const seen: string[] = [];
  await expect(
    runShardTests(
      ["z.test.ts", "a.test.ts", "direct.test.ts"],
      async (path) => {
        seen.push(path);
        if (path === "direct.test.ts") throw new Error("fail");
      },
      true,
      ["direct.test.ts"],
    ),
  ).rejects.toThrow("fail");
  expect(seen).toEqual(["direct.test.ts", "a.test.ts", "z.test.ts"]);
});

describe("parseShardArgs", () => {
  test("keeps global compatibility and accepts only complete shard selection", () => {
    expect(parseShardArgs(["--list"])).toEqual({ mode: "global", passthrough: ["--list"] });
    expect(
      parseShardArgs(["--shard-manifest", "wave.json", "--shard", "shared", "--list"]),
    ).toEqual({ mode: "shard", manifest: "wave.json", shard: "shared", passthrough: ["--list"] });
    expect(parseShardArgs(["--shard-manifest", "wave.json"])).toEqual({
      error: "--shard-manifest requires --shard and both require values",
    });
  });
});

test("canonical core selection follows direct test imports across every admitted surface", () => {
  const target = "apps/cockpit/src/pages/core/new-view.ts";
  const direct = "apps/cockpit/src/pages/new-view.test.ts";
  const indirect = "apps/cockpit/src/pages/page.test.tsx";
  const unavailable = "apps/cockpit/src/pages/deleted.test.ts";
  const reverse = new Map([
    [target, new Set([direct, unavailable, "apps/cockpit/src/pages/facade.ts"])],
  ]);
  expect(selectCanonicalCoreTests([direct, indirect], [target], reverse)).toEqual([direct]);
  expect(selectCanonicalCoreTests([direct, indirect], [], reverse)).toEqual([]);
});
