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
      { slug: "fresh", last_turn: 10 },
      { slug: "edge-in", last_turn: 8 },
      { slug: "edge-out", last_turn: 7 },
      { slug: "stale", last_turn: 1 },
    ];
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set());
    expect(r.fullBodySet.sort()).toEqual(["edge-in", "fresh"]);
    expect(r.membership.sort()).toEqual(["edge-in", "edge-out", "fresh", "stale"]);
  });

  test("entries past the retention horizon are pruned from membership", () => {
    const currentTurn = 100;
    const loaded: LoadedSkillEntry[] = [
      { slug: "fresh", last_turn: 100 },
      { slug: "demoted", last_turn: 100 - R + 1 },
      { slug: "expired", last_turn: 100 - R },
    ];
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set());
    expect(r.membership.sort()).toEqual(["demoted", "fresh"]);
    expect(r.fullBodySet).toEqual(["fresh"]);
  });

  test("refresh promotes a matched slug's last_turn to currentTurn", () => {
    const currentTurn = 10;
    const loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 5 }];
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
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set(["baseline"]));
    expect(r.membership).toContain("baseline");
    expect(r.fullBodySet).not.toContain("baseline");
  });

  test("continuation-style: untouched topical skill demotes at K but stays index-visible", () => {
    let loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 1 }];
    let fullBodyAtK = true;
    for (let turn = 2; turn <= 1 + K; turn += 1) {
      const r = applyRecency(loaded, turn, new Set(), [], new Set());
      fullBodyAtK = r.fullBodySet.includes("topic");
      loaded = r.next;
    }
    expect(fullBodyAtK).toBe(false);
    expect(loaded.find((e) => e.slug === "topic")).toBeDefined();
  });

  test("continuation-style: topical skill is finally pruned at the retention horizon", () => {
    let loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 1 }];
    for (let turn = 2; turn <= 1 + R; turn += 1) {
      const r = applyRecency(loaded, turn, new Set(), [], new Set());
      loaded = r.next;
    }
    expect(loaded.find((e) => e.slug === "topic")).toBeUndefined();
  });
});

describe("applyRecency — recency window across turns (K=3 stepping)", () => {
  test("a skill refreshed at turn N stays full-body for exactly K-1 subsequent turns", () => {
    let loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 5 }];
    const neverPrune = new Set<string>();

    for (const turn of [6, 7]) {
      const r = applyRecency(loaded, turn, new Set(), [], neverPrune);
      expect(r.fullBodySet).toContain("topic");
      expect(r.membership).toContain("topic");
      loaded = r.next;
    }
    const r8 = applyRecency(loaded, 8, new Set(), [], neverPrune);
    expect(r8.fullBodySet).not.toContain("topic");
    expect(r8.membership).toContain("topic");
  });

  test("re-refreshing a skill at the edge turn resets its K-turn countdown", () => {
    let loaded: LoadedSkillEntry[] = [{ slug: "topic", last_turn: 5 }];
    const neverPrune = new Set<string>();

    const r7 = applyRecency(loaded, 7, new Set(["topic"]), [], neverPrune);
    expect(r7.fullBodySet).toContain("topic");
    loaded = r7.next;
    expect(loaded.find((e) => e.slug === "topic")?.last_turn).toBe(7);

    const r9 = applyRecency(loaded, 9, new Set(), [], neverPrune);
    expect(r9.fullBodySet).toContain("topic");

    const r10 = applyRecency(r9.next, 10, new Set(), [], neverPrune);
    expect(r10.fullBodySet).not.toContain("topic");
    expect(r10.membership).toContain("topic");
  });

  test("loaded set stays bounded: full body by K, membership by the retention horizon", () => {
    const baseline: LoadedSkillEntry = { slug: "base", last_turn: 0 };
    let loaded: LoadedSkillEntry[] = [baseline];
    const neverPrune = new Set(["base"]);
    const maxFullBody: number[] = [];
    const maxMembership: number[] = [];

    for (let turn = 1; turn <= R + 5; turn++) {
      const additions = [`topic-${turn}`];
      const r = applyRecency(loaded, turn, new Set(["base"]), additions, neverPrune);
      loaded = r.next;
      maxFullBody.push(r.fullBodySet.length);
      maxMembership.push(r.membership.length);
    }

    expect(Math.max(...maxFullBody)).toBeLessThanOrEqual(K + 1);
    expect(Math.max(...maxMembership)).toBeLessThanOrEqual(R + 1);
    expect(loaded.some((e) => e.slug === "base")).toBe(true);
    expect(loaded.some((e) => e.slug === "topic-1")).toBe(false);
  });

  test("addition that duplicates an already-loaded slug just refreshes recency, no duplicate", () => {
    const currentTurn = 5;
    const loaded: LoadedSkillEntry[] = [{ slug: "http-connectors", last_turn: 2 }];
    const r = applyRecency(loaded, currentTurn, new Set(), ["http-connectors"], new Set());
    const count = r.next.filter((e) => e.slug === "http-connectors").length;
    expect(count).toBe(1);
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
    expect(r.fullBodySet).toContain("base-a");
    expect(r.fullBodySet).toContain("base-b");
  });

  test("fullBodySet is a strict subset of membership", () => {
    const currentTurn = 10;
    const loaded: LoadedSkillEntry[] = [
      { slug: "base", last_turn: 1 },
      { slug: "fresh", last_turn: 9 },
    ];
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set(["base"]));
    for (const slug of r.fullBodySet) {
      expect(r.membership).toContain(slug);
    }
    expect(r.membership).toContain("base");
    expect(r.fullBodySet).not.toContain("base");
    expect(r.fullBodySet).toContain("fresh");
  });

  test("duplicate-slug input collapses to one entry; last writer's last_turn wins", () => {
    const currentTurn = 10;
    const loaded: LoadedSkillEntry[] = [
      { slug: "a", last_turn: 2 },
      { slug: "a", last_turn: 5 },
    ];
    const r = applyRecency(loaded, currentTurn, new Set(), [], new Set());
    expect(r.next.filter((e) => e.slug === "a")).toHaveLength(1);
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
        { slug: "", last_turn: 2 },
        { slug: "bad-turn", last_turn: "x" },
        "plain-string",
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
