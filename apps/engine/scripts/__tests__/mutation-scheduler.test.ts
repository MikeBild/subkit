import { describe, expect, test } from "bun:test";
import { planMutationBatches } from "../audit/mutation-scheduler.ts";

describe("mutation shard resource budget", () => {
  test("parallelizes independent shards without multiplying the global worker budget", () => {
    expect(
      planMutationBatches(
        [
          { id: "workflows", resource_tags: [] },
          { id: "cli", resource_tags: [] },
          { id: "shared", resource_tags: [] },
        ],
        8,
      ),
    ).toEqual([
      [
        { id: "cli", workers: 3 },
        { id: "shared", workers: 3 },
        { id: "workflows", workers: 2 },
      ],
    ]);
  });

  test("serializes overlapping resources while admitting unrelated work", () => {
    const shards = [
      { id: "a", resource_tags: ["postgres", "port-3000"] },
      { id: "b", resource_tags: ["postgres"] },
      { id: "c", resource_tags: ["port-3000"] },
      { id: "d", resource_tags: [] },
    ];
    const before = structuredClone(shards);
    expect(planMutationBatches(shards, 3)).toEqual([
      [
        { id: "a", workers: 2 },
        { id: "d", workers: 1 },
      ],
      [
        { id: "b", workers: 2 },
        { id: "c", workers: 1 },
      ],
    ]);
    expect(shards).toEqual(before);
  });

  test("limits concurrently active shards even with one worker each", () => {
    expect(
      planMutationBatches(
        [
          { id: "a", resource_tags: [] },
          { id: "b", resource_tags: [] },
          { id: "c", resource_tags: [] },
        ],
        2,
      ),
    ).toEqual([
      [
        { id: "a", workers: 1 },
        { id: "b", workers: 1 },
      ],
      [{ id: "c", workers: 2 }],
    ]);
    expect(planMutationBatches([], 2)).toEqual([]);
  });

  test("rejects ambiguous shards, invalid resource tags and invalid budgets", () => {
    for (const budget of [0, -1, 1.5, Number.NaN, Infinity])
      expect(() => planMutationBatches([], budget)).toThrow();
    expect(() => planMutationBatches([{ id: "", resource_tags: [] }], 1)).toThrow();
    expect(() =>
      planMutationBatches(
        [
          { id: "a", resource_tags: [] },
          { id: "a", resource_tags: [] },
        ],
        1,
      ),
    ).toThrow();
    expect(() => planMutationBatches([{ id: "a", resource_tags: [" "] }], 1)).toThrow();
  });
});
