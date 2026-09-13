import { describe, expect, test } from "bun:test";

import { memberCountAfterMove, recategorizedSlug } from "./workflow-category";

describe("recategorized slug", () => {
  test("swaps the current family prefix for the target one", () => {
    expect(recategorizedSlug("radar-collect-weekly", "radar", "mission-control")).toBe(
      "mission-control-collect-weekly",
    );
  });

  test("prefixes a slug that has no family yet", () => {
    expect(recategorizedSlug("ga4-daily-report", "other", "mission-control")).toBe(
      "mission-control-ga4-daily-report",
    );
  });

  test("strips the family when the workflow leaves every block", () => {
    expect(recategorizedSlug("radar-collect-weekly", "radar", "other")).toBe("collect-weekly");
  });

  test("keeps a slug that already heads its target family", () => {
    expect(recategorizedSlug("radar", "radar", "radar")).toBe("radar");
    expect(recategorizedSlug("radar-collect", "radar", "radar")).toBe("radar-collect");
  });

  test("does not treat the catch-all name as a prefix to strip", () => {
    expect(recategorizedSlug("other-thing", "other", "radar")).toBe("radar-other-thing");
  });
});

describe("member count after a move", () => {
  const counts = new Map([
    ["radar", 6],
    ["mission-control", 2],
  ]);

  test("counts the arriving workflow into the target family", () => {
    expect(memberCountAfterMove(counts, "radar", "mission-control")).toBe(3);
  });

  test("does not double-count a workflow that stays put", () => {
    expect(memberCountAfterMove(counts, "radar", "radar")).toBe(6);
  });

  test("treats an unknown target as its first member", () => {
    expect(memberCountAfterMove(counts, "radar", "fresh")).toBe(1);
  });
});
