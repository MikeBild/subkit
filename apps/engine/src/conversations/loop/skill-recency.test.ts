// Pure recency-math unit tests for the smart skill loader.

import { describe, expect, test } from "bun:test";
import {
  applyRecency,
  type LoadedSkillEntry,
  parseLoadedSkills,
  SKILL_FULL_BODY_RECENCY_K,
  SKILL_RETENTION_TURNS,
} from "./skill-recency.ts";

const K = SKILL_FULL_BODY_RECENCY_K;
const R = SKILL_RETENTION_TURNS;

describe("applyRecency — full-body window (K=3)", () => {
  test("fullBodySet = entries with age < K; demoted entries stay in membership", () => {
    const currentTurn = 10;
    const loaded: LoadedSkillEntry[] = [
      { slug: "fresh", last_turn: 10 }, // age 0 → full body
      { slug: "edge-in", last_turn: 8 }, // age 2 < 3 → full body
      { slug: "edge-out", last_turn: 7 }, // age 3 >= K → demoted, NOT pruned
      { slug: "stale", last_turn: 1 }, // age 9 (< R) → demoted, NOT pruned
    ];
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set());
    expect(r.fullBodySet.sort()).toEqual(["edge-in", "fresh"]);
    // Demoted entries leave the full-body set but REMAIN index-visible in
    // membership until they cross the retention horizon (no skill disappears).
    expect(r.membership.sort()).toEqual(["edge-in", "edge-out", "fresh", "stale"]);
  });

  test("entries past the retention horizon are pruned from membership", () => {
    const currentTurn = 100;
    const loaded: LoadedSkillEntry[] = [
      { slug: "fresh", last_turn: 100 }, // age 0
      { slug: "demoted", last_turn: 100 - R + 1 }, // age R-1 < R → still index-visible
      { slug: "expired", last_turn: 100 - R }, // age R >= R → pruned
    ];
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set());
    expect(r.membership.sort()).toEqual(["demoted", "fresh"]);
    expect(r.fullBodySet).toEqual(["fresh"]);
  });

  test("refresh promotes a matched slug's last_turn to currentTurn", () => {
    const currentTurn = 10;
    const loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 5 }]; // age 5 → would be out
    const r = applyRecency(loaded, currentTurn, new Set(["topic"]), [], new Set());
    expect(r.fullBodySet).toContain("topic");
    expect(r.next.find((e) => e.slug === "topic")?.last_turn).toBe(currentTurn);
  });

  test("additions enter at last_turn = currentTurn (immediately full-body)", () => {
    const currentTurn = 4;
    const r = applyRecency([], currentTurn, new Set(), ["new-skill"], new Set());
    expect(r.fullBodySet).toEqual(["new-skill"]);
    expect(r.next).toEqual([{ slug: "new-skill", last_turn: currentTurn }]);
  });

  test("baseline (neverPrune) survives even past K and is refreshed", () => {
    const currentTurn = 100;
    const loaded: LoadedSkillEntry[] = [{ slug: "baseline", last_turn: 1 }];
    const r = applyRecency(loaded, currentTurn, new Set(["baseline"]), [], new Set(["baseline"]));
    expect(r.membership).toContain("baseline");
    expect(r.fullBodySet).toContain("baseline");
  });

  test("an un-refreshed neverPrune slug stays in membership but leaves the full-body set", () => {
    const currentTurn = 100;
    const loaded: LoadedSkillEntry[] = [{ slug: "baseline", last_turn: 1 }];
    // Not in refresh this turn (e.g. a degenerate continuation) but never pruned.
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set(["baseline"]));
    expect(r.membership).toContain("baseline");
    expect(r.fullBodySet).not.toContain("baseline");
  });

  test("continuation-style: untouched topical skill demotes at K but stays index-visible", () => {
    let loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 1 }];
    // Continuation turns where only baseline refreshes — topic is never in
    // the refresh set. At age K it leaves the full-body set but remains in
    // membership (index-visible) until the retention horizon.
    let fullBodyAtK = true;
    for (let turn = 2; turn <= 1 + K; turn += 1) {
      const r = applyRecency(loaded, turn, new Set(), [], new Set());
      fullBodyAtK = r.fullBodySet.includes("topic");
      loaded = r.next;
    }
    // At turn 1+K the topic reaches age K → demoted from full body...
    expect(fullBodyAtK).toBe(false);
    // ...but it is NOT pruned (age K < R) — still index-visible.
    expect(loaded.find((e) => e.slug === "topic")).toBeDefined();
  });

  test("continuation-style: topical skill is finally pruned at the retention horizon", () => {
    let loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 1 }];
    // Run until the topic reaches the retention horizon (age R) with no
    // refresh — it should disappear from membership only now.
    for (let turn = 2; turn <= 1 + R; turn += 1) {
      const r = applyRecency(loaded, turn, new Set(), [], new Set());
      loaded = r.next;
    }
    // At turn 1+R the topic reaches age R and is pruned from membership.
    expect(loaded.find((e) => e.slug === "topic")).toBeUndefined();
  });
});

describe("applyRecency — recency window across turns (K=3 stepping)", () => {
  test("a skill refreshed at turn N stays full-body for exactly K-1 subsequent turns", () => {
    // Skill refreshed at turn 5. K=3 so it stays full-body at turns 5, 6, 7 (age 0,1,2).
    // At turn 8 (age 3 >= K) it is DEMOTED to the index — but still in membership.
    let loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 5 }];
    const neverPrune = new Set<string>();

    for (const turn of [6, 7]) {
      const r = applyRecency(loaded, turn, new Set(), [], neverPrune);
      expect(r.fullBodySet).toContain("topic");
      expect(r.membership).toContain("topic");
      loaded = r.next;
    }
    // Turn 8: age = 8 - 5 = 3 = K → demoted from full body but index-visible.
    const r8 = applyRecency(loaded, 8, new Set(), [], neverPrune);
    expect(r8.fullBodySet).not.toContain("topic");
    expect(r8.membership).toContain("topic");
  });

  test("re-refreshing a skill at the edge turn resets its K-turn countdown", () => {
    // Skill at last_turn=5; at turn 7 (age=2, still in window) it is re-affirmed.
    let loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 5 }];
    const neverPrune = new Set<string>();

    // Turn 7: refresh resets last_turn to 7.
    const r7 = applyRecency(loaded, 7, new Set(["topic"]), [], neverPrune);
    expect(r7.fullBodySet).toContain("topic");
    loaded = r7.next;
    expect(loaded.find((e) => e.slug === "topic")?.last_turn).toBe(7);

    // Turn 9: age = 9 - 7 = 2 < K → still full-body.
    const r9 = applyRecency(loaded, 9, new Set(), [], neverPrune);
    expect(r9.fullBodySet).toContain("topic");

    // Turn 10: age = 10 - 7 = 3 = K → demoted from full body but index-visible.
    const r10 = applyRecency(r9.next, 10, new Set(), [], neverPrune);
    expect(r10.fullBodySet).not.toContain("topic");
    expect(r10.membership).toContain("topic");
  });

  test("loaded set stays bounded: full body by K, membership by the retention horizon", () => {
    // Simulate a long conversation with rotating topics. Baseline stays
    // (neverPrune); each turn adds a fresh topic. The FULL-BODY set is
    // bounded by K (cost control); MEMBERSHIP is bounded by the retention
    // horizon (no skill disappears before then), and old topics are
    // eventually pruned so the loaded set cannot grow without bound.
    const baseline: LoadedSkillEntry = { slug: "base", last_turn: 0 };
    let loaded: LoadedSkillEntry[] = [baseline];
    const neverPrune = new Set(["base"]);
    const maxFullBody: number[] = [];
    const maxMembership: number[] = [];

    // Run well past the retention horizon so pruning is exercised.
    for (let turn = 1; turn <= R + 5; turn++) {
      const additions = [`topic-${turn}`];
      const r = applyRecency(loaded, turn, new Set(["base"]), additions, neverPrune);
      loaded = r.next;
      maxFullBody.push(r.fullBodySet.length);
      maxMembership.push(r.membership.length);
    }

    // Full body: at most K fresh topics + 1 baseline.
    expect(Math.max(...maxFullBody)).toBeLessThanOrEqual(K + 1);
    // Membership: at most R index-visible topics + 1 baseline. It never
    // grows past the retention horizon even with a fresh topic every turn.
    expect(Math.max(...maxMembership)).toBeLessThanOrEqual(R + 1);
    // Baseline still present after the whole run.
    expect(loaded.some((e) => e.slug === "base")).toBe(true);
    // The very first topic is long gone (pruned at the retention horizon).
    expect(loaded.some((e) => e.slug === "topic-1")).toBe(false);
  });

  test("addition that duplicates an already-loaded slug just refreshes recency, no duplicate", () => {
    const currentTurn = 5;
    const loaded: LoadedSkillEntry[] = [{ slug: "http-connectors", last_turn: 2 }]; // age 3, demoted
    // An autoload addition re-introduces the same slug, re-promoting it.
    const r = applyRecency(loaded, currentTurn, new Set(), ["http-connectors"], new Set());
    // Should appear exactly once.
    const count = r.next.filter((e) => e.slug === "http-connectors").length;
    expect(count).toBe(1);
    // And it should be at currentTurn (addition wins over stale last_turn).
    expect(r.next.find((e) => e.slug === "http-connectors")?.last_turn).toBe(currentTurn);
    expect(r.fullBodySet).toContain("http-connectors");
  });

  test("empty loaded + empty additions + empty refresh → all empty outputs", () => {
    const r = applyRecency([], 0, new Set(), [], new Set());
    expect(r.next).toEqual([]);
    expect(r.fullBodySet).toEqual([]);
    expect(r.membership).toEqual([]);
  });

  test("refresh of a slug NOT in loaded set is silently ignored (no phantom entry)", () => {
    const currentTurn = 5;
    const loaded: LoadedSkillEntry[] = [{ slug: "a", last_turn: 5 }];
    // "ghost" is in the refresh set but was never loaded.
    const r = applyRecency(loaded, currentTurn, new Set(["ghost"]), [], new Set());
    expect(r.next.map((e) => e.slug)).not.toContain("ghost");
    expect(r.fullBodySet).not.toContain("ghost");
  });

  test("multiple baseline slugs in neverPrune all survive long past K", () => {
    const currentTurn = 999;
    const loaded: LoadedSkillEntry[] = [
      { slug: "base-a", last_turn: 0 },
      { slug: "base-b", last_turn: 0 },
    ];
    const neverPrune = new Set(["base-a", "base-b"]);
    const r = applyRecency(loaded, currentTurn, new Set(["base-a", "base-b"]), [], neverPrune);
    expect(r.membership).toContain("base-a");
    expect(r.membership).toContain("base-b");
    // Both refreshed this turn → full-body.
    expect(r.fullBodySet).toContain("base-a");
    expect(r.fullBodySet).toContain("base-b");
  });

  test("fullBodySet is a strict subset of membership", () => {
    const currentTurn = 10;
    const loaded: LoadedSkillEntry[] = [
      { slug: "base", last_turn: 1 }, // age 9, neverPrune → in membership, NOT full-body
      { slug: "fresh", last_turn: 9 }, // age 1 → full-body
    ];
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set(["base"]));
    for (const slug of r.fullBodySet) {
      expect(r.membership).toContain(slug);
    }
    // base is in membership but not full-body (not refreshed this turn, age >= K).
    expect(r.membership).toContain("base");
    expect(r.fullBodySet).not.toContain("base");
    expect(r.fullBodySet).toContain("fresh");
  });

  test("duplicate-slug input collapses to one entry; last writer's last_turn wins", () => {
    // The persisted array is merge-by-slug everywhere it is written, but
    // applyRecency is defensive about a degenerate duplicate input. Pin the
    // last-writer-wins policy so a future refactor cannot silently flip it.
    const currentTurn = 10;
    const loaded: LoadedSkillEntry[] = [
      { slug: "a", last_turn: 2 },
      { slug: "a", last_turn: 5 },
    ];
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set());
    // Collapsed to exactly one "a".
    expect(r.next.filter((e) => e.slug === "a")).toHaveLength(1);
    // The LAST entry in the array wins (last_turn = 5, age 5 → demoted).
    expect(r.next.find((e) => e.slug === "a")?.last_turn).toBe(5);
    expect(r.membership).toEqual(["a"]);
    expect(r.fullBodySet).toEqual([]);
  });

  test("refresh of a duplicated slug promotes to currentTurn regardless of input order", () => {
    const currentTurn = 10;
    const loaded: LoadedSkillEntry[] = [
      { slug: "a", last_turn: 5 },
      { slug: "a", last_turn: 2 },
    ];
    // Refresh wins over either stale last_turn.
    const r = applyRecency(loaded, currentTurn, new Set(["a"]), [], new Set());
    expect(r.next.filter((e) => e.slug === "a")).toHaveLength(1);
    expect(r.next.find((e) => e.slug === "a")?.last_turn).toBe(currentTurn);
    expect(r.fullBodySet).toEqual(["a"]);
  });
});

describe("parseLoadedSkills — boundary validation", () => {
  test("valid {slug,last_turn} array passes through unchanged", () => {
    const raw = [
      { slug: "a", last_turn: 0 },
      { slug: "b", last_turn: 3 },
    ];
    expect(parseLoadedSkills(raw)).toEqual(raw);
  });

  test("null / undefined → empty array, no onInvalid call", () => {
    let invalidCalls = 0;
    expect(parseLoadedSkills(null, () => invalidCalls++)).toEqual([]);
    expect(parseLoadedSkills(undefined, () => invalidCalls++)).toEqual([]);
    expect(invalidCalls).toBe(0);
  });

  test("string[] ratchet rows are dropped (not cast to undefined slugs)", () => {
    const seen: Array<{ dropped: number; raw: unknown }> = [];
    // The pre-migration shape: a bare array of slug strings.
    const out = parseLoadedSkills(["http-connectors", "gmail"], (info) => seen.push(info));
    expect(out).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.dropped).toBe(2);
  });

  test("mixed valid + malformed entries keeps the valid ones and reports the drops", () => {
    const seen: Array<{ dropped: number; raw: unknown }> = [];
    const out = parseLoadedSkills(
      [
        { slug: "ok", last_turn: 1 },
        { slug: "", last_turn: 2 }, // empty slug → invalid
        { slug: "bad-turn", last_turn: "x" }, // non-numeric → invalid
        "plain-string", // wrong shape → invalid
        { slug: "ok2", last_turn: 4 },
      ],
      (info) => seen.push(info),
    );
    expect(out).toEqual([
      { slug: "ok", last_turn: 1 },
      { slug: "ok2", last_turn: 4 },
    ]);
    expect(seen[0]?.dropped).toBe(3);
  });

  test("a non-array value reports invalid and yields empty", () => {
    const seen: Array<{ dropped: number; raw: unknown }> = [];
    expect(parseLoadedSkills({ slug: "a", last_turn: 0 }, (info) => seen.push(info))).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.dropped).toBe(0);
  });
});
