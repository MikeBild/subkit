import { describe, expect, test } from "bun:test";
import {
  formatShardTestObservation,
  orderShardTests,
  parseShardArgs,
  parseShardTestHistory,
  runShardTests,
  selectCanonicalCoreTests,
  selectCoreTests,
  selectShardMutationTests,
  shardTestImportDistance,
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

test("runs earlier mutant killers first, weighted by how fast they decide", () => {
  const paths = ["a.test.ts", "direct.test.ts", "slow-killer.test.ts", "fast-killer.test.ts"];
  const history = parseShardTestHistory(
    [
      formatShardTestObservation({ test: "slow-killer.test.ts", durationMs: 12_000, failed: true }),
      formatShardTestObservation({ test: "slow-killer.test.ts", durationMs: 12_000, failed: true }),
      formatShardTestObservation({ test: "fast-killer.test.ts", durationMs: 400, failed: true }),
      formatShardTestObservation({ test: "fast-killer.test.ts", durationMs: 400, failed: false }),
      formatShardTestObservation({ test: "a.test.ts", durationMs: 50, failed: false }),
    ].join(""),
  );
  const ordered = orderShardTests(paths, ["direct.test.ts"], history);
  expect(ordered).toEqual([
    "fast-killer.test.ts",
    "slow-killer.test.ts",
    "direct.test.ts",
    "a.test.ts",
  ]);
  expect([...ordered].sort()).toEqual([...paths].sort());
});

test("order hints never narrow or extend the reviewed test set", async () => {
  const paths = ["b.test.ts", "a.test.ts"];
  const history = parseShardTestHistory(
    [
      "not json",
      "{}",
      JSON.stringify({ t: "outside.test.ts", ms: 10, f: 1 }),
      JSON.stringify({ t: "b.test.ts", ms: -1, f: 1 }),
      JSON.stringify({ t: "b.test.ts", ms: 10, f: 2 }),
      JSON.stringify({ t: "b.test.ts", ms: 10, f: 1 }),
      "",
    ].join("\n"),
  );
  expect(history.get("b.test.ts")).toEqual({ kills: 1, runs: 1, totalMs: 10 });
  expect(orderShardTests(paths, [], history)).toEqual(["b.test.ts", "a.test.ts"]);
  const seen: string[] = [];
  await runShardTests(paths, async (path) => void seen.push(path), false, [], history);
  expect(seen).toEqual(["b.test.ts", "a.test.ts"]);
});

test("without kill history the nearest importers of a target run before distant ones", async () => {
  expect(shardTestImportDistance("imports apps/engine/src/a.ts (depth 2)")).toBe(2);
  expect(shardTestImportDistance("imports apps/engine/src/a.ts (depth 12)")).toBe(12);
  expect(shardTestImportDistance("reads apps/engine/src/a.ts as text")).toBeUndefined();
  expect(shardTestImportDistance("imports (depth 2) apps/engine/src/a.ts")).toBeUndefined();
  const paths = ["a-far.test.ts", "b-unknown.test.ts", "direct.test.ts", "z-near.test.ts"];
  const distances = new Map([
    ["a-far.test.ts", 7],
    ["z-near.test.ts", 2],
    ["outside.test.ts", 1],
  ]);
  const ordered = orderShardTests(paths, ["direct.test.ts"], new Map(), distances);
  expect(ordered).toEqual([
    "direct.test.ts",
    "z-near.test.ts",
    "a-far.test.ts",
    "b-unknown.test.ts",
  ]);
  const history = parseShardTestHistory(
    formatShardTestObservation({ test: "a-far.test.ts", durationMs: 300, failed: true }),
  );
  expect(orderShardTests(paths, ["direct.test.ts"], history, distances)).toEqual([
    "a-far.test.ts",
    "direct.test.ts",
    "z-near.test.ts",
    "b-unknown.test.ts",
  ]);
  const seen: string[] = [];
  await runShardTests(paths, async (path) => void seen.push(path), false, [], new Map(), distances);
  expect(seen).toEqual(["z-near.test.ts", "a-far.test.ts", "b-unknown.test.ts", "direct.test.ts"]);
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

test("a mutation test radius keeps direct, contract and near importers and drops distant ones", () => {
  const tests = [
    { path: "direct.test.ts", kind: "direct", rationale: "imports core.ts (depth 1)" },
    { path: "contract.test.ts", kind: "consumer_contract", rationale: "runtime witness" },
    { path: "text.test.ts", kind: "reverse_import", rationale: "reads core.ts as text" },
    { path: "near.test.ts", kind: "reverse_import", rationale: "imports core.ts (depth 2)" },
    { path: "far.test.ts", kind: "reverse_import", rationale: "imports core.ts (depth 3)" },
  ];
  expect(selectShardMutationTests(tests, 2).map((entry) => entry.path)).toEqual([
    "direct.test.ts",
    "contract.test.ts",
    "text.test.ts",
    "near.test.ts",
  ]);
  expect(selectShardMutationTests(tests, undefined)).toEqual(tests);
  for (const radius of [0, -1, 1.5, Number.NaN])
    expect(() => selectShardMutationTests(tests, radius)).toThrow("positive safe integer");
});
