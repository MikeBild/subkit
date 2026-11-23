import { describe, expect, test } from "bun:test";
import {
  CARRY_ORIGIN_MAX_HOPS,
  decideCarryUnderPolicy,
  pairApprovedOrigin,
} from "./authority-policy.ts";

describe("an approval carries to a new version only as far as the workspace policy allows", () => {
  test("one approver is enough where the workspace asks for one", () => {
    expect(decideCarryUnderPolicy({ policy: "single", pair_approved: false })).toBe("carry");
    expect(decideCarryUnderPolicy({ policy: "single", pair_approved: true })).toBe("carry");
  });

  test("a workspace that asks for two people does not carry what one person approved", () => {
    expect(decideCarryUnderPolicy({ policy: "pair", pair_approved: false })).toBe("needs_pair");
  });

  test("what two people approved carries under the pair policy", () => {
    expect(decideCarryUnderPolicy({ policy: "pair", pair_approved: true })).toBe("carry");
  });
});

describe("the approval an inherited one goes back to decides", () => {
  const lineage = [
    { id: "root", inherited_from: null },
    { id: "child", inherited_from: "root" },
    { id: "grandchild", inherited_from: "child" },
    { id: "single", inherited_from: null },
    { id: "orphan", inherited_from: "gone" },
  ];

  test("an approval two people granted is pair approved", () => {
    expect(pairApprovedOrigin(lineage, "root", new Set(["root"]))).toBe(true);
  });

  test("an approval carried from one two people granted stays pair approved", () => {
    expect(pairApprovedOrigin(lineage, "grandchild", new Set(["root"]))).toBe(true);
    expect(pairApprovedOrigin(lineage, "grandchild", new Set(["child"]))).toBe(true);
  });

  test("an approval one person granted is not, nor is one whose origin is unknown", () => {
    expect(pairApprovedOrigin(lineage, "single", new Set(["root"]))).toBe(false);
    expect(pairApprovedOrigin(lineage, "orphan", new Set(["root"]))).toBe(false);
    expect(pairApprovedOrigin(lineage, "missing", new Set(["root"]))).toBe(false);
  });

  test("a lineage that loops ends without an answer", () => {
    const loop = [
      { id: "a", inherited_from: "b" },
      { id: "b", inherited_from: "a" },
    ];
    expect(pairApprovedOrigin(loop, "a", new Set(["root"]))).toBe(false);
  });

  test("the walk stops after the hop limit", () => {
    const long = Array.from({ length: CARRY_ORIGIN_MAX_HOPS + 2 }, (_, index) => ({
      id: `n${index}`,
      inherited_from: index === 0 ? null : `n${index - 1}`,
    }));
    expect(pairApprovedOrigin(long, `n${CARRY_ORIGIN_MAX_HOPS + 1}`, new Set(["n0"]))).toBe(false);
    expect(pairApprovedOrigin(long, `n${CARRY_ORIGIN_MAX_HOPS - 1}`, new Set(["n0"]))).toBe(true);
  });
});
