import { describe, expect, test } from "bun:test";
import { staleSnapshots } from "../lib/migration-snapshots.ts";

describe("staleSnapshots", () => {
  test("keeps only the highest-numbered snapshot", () => {
    expect(
      staleSnapshots([
        "_journal.json",
        "0001_snapshot.json",
        "0000_snapshot.json",
        "0010_snapshot.json",
      ]),
    ).toEqual(["0000_snapshot.json", "0001_snapshot.json"]);
  });

  test("orders numerically, not lexically", () => {
    expect(staleSnapshots(["0002_snapshot.json", "0010_snapshot.json"])).toEqual([
      "0002_snapshot.json",
    ]);
  });

  test("a single snapshot or none is never stale", () => {
    expect(staleSnapshots(["0003_snapshot.json", "_journal.json"])).toEqual([]);
    expect(staleSnapshots([])).toEqual([]);
  });

  test("ignores files that only look similar", () => {
    expect(
      staleSnapshots(["0000_snapshot.json.bak", "snapshot.json", "0001_snapshot.json"]),
    ).toEqual([]);
  });
});
