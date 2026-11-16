import { describe, expect, test } from "bun:test";
import {
  assertCanonicalWaveOwners,
  assertWaveMatchesQualityPolicy,
  parseQualityShardPolicy,
} from "../audit/quality-shard-policy.ts";

const policy = {
  version: 1 as const,
  worker_budget: 2,
  equivalence_manifest_path: "apps/engine/.mutation-equivalents.json",
  shards: [{ id: "workflows", resource_tags: ["db", "ports", "global-state"] }],
};

describe("versioned quality resource policy", () => {
  test("admits explicit resource ownership without changing the policy", () => {
    expect(parseQualityShardPolicy(policy, ["workflows"])).toBe(policy);
  });
  test("admits an optional positive mutation test radius and rejects unsafe ones", () => {
    const narrowed = { ...policy, mutation_test_radius: 2 };
    expect(parseQualityShardPolicy(narrowed, ["workflows"]).mutation_test_radius).toBe(2);
    for (const mutation_test_radius of [0, -1, 1.5, Number.NaN, "2", null])
      expect(() => parseQualityShardPolicy({ ...policy, mutation_test_radius }, [])).toThrow();
  });
  test("new canonical owners require explicit resource classification", () => {
    expect(() => parseQualityShardPolicy(policy, ["workflows", "identity"])).toThrow(
      "Missing reviewed resource policy: identity",
    );
  });
  test("rejects malformed headers and unsafe budgets", () => {
    for (const value of [
      null,
      false,
      {},
      { ...policy, version: 2 },
      ...[0, -1, 1.5, Infinity, NaN, "2"].map((worker_budget) => ({ ...policy, worker_budget })),
      { ...policy, equivalence_manifest_path: "../../policy.json" },
      { ...policy, shards: null },
    ]) {
      expect(() => parseQualityShardPolicy(value, [])).toThrow();
    }
  });
  test("rejects duplicate owners and unknown or duplicate resource tags", () => {
    for (const shards of [
      [...policy.shards, ...policy.shards],
      [null],
      [{ id: "../workflow", resource_tags: [] }],
      [{ id: "workflows", resource_tags: ["network"] }],
      [{ id: "workflows", resource_tags: ["db", "db"] }],
      [{ id: "workflows", resource_tags: "db" }],
    ]) {
      expect(() => parseQualityShardPolicy({ ...policy, shards }, [])).toThrow();
    }
  });
});

test("a frozen wave cannot drop serialization or change worker budget", () => {
  const reviewed = parseQualityShardPolicy(policy, ["workflows"]);
  expect(() => assertWaveMatchesQualityPolicy(reviewed, policy)).not.toThrow();
  for (const wave of [
    { ...policy, worker_budget: 3 },
    { ...policy, equivalence_manifest_path: "other.json" },
    { ...policy, shards: [{ id: "workflows", resource_tags: [] }] },
    { ...policy, shards: [{ id: "workflows", resource_tags: ["db", "db", "db"] }] },
    { ...policy, shards: [{ id: "foreign", resource_tags: [] }] },
  ])
    expect(() => assertWaveMatchesQualityPolicy(reviewed, wave)).toThrow();
});

test("omitting a constrained shard or moving its targets cannot bypass resource policy", () => {
  const reviewed = parseQualityShardPolicy(
    {
      ...policy,
      shards: [
        ...policy.shards,
        { id: "connectors", resource_tags: ["db", "ports", "global-state"] },
      ],
    },
    ["workflows", "connectors"],
  );
  expect(() => assertWaveMatchesQualityPolicy(reviewed, policy)).toThrow("shard inventory");
  const moved = {
    shards: [
      { id: "connectors", targets: [] },
      { id: "workflows", targets: ["connector.ts"] },
    ],
  };
  expect(() =>
    assertCanonicalWaveOwners(moved, [{ path: "connector.ts", owner_shard: "connectors" }]),
  ).toThrow("canonical owner");
  expect(() =>
    assertCanonicalWaveOwners({ shards: [{ id: "connectors", targets: ["connector.ts"] }] }, [
      { path: "connector.ts", owner_shard: "connectors" },
    ]),
  ).not.toThrow();
});
