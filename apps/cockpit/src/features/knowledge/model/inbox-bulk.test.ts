import { describe, expect, it } from "bun:test";
import {
  BULK_PROPOSE_LIMIT,
  bulkActions,
  entryGroupKey,
  groupLabel,
  isSelectable,
  runBulk,
} from "./inbox-bulk";

describe("bulkActions", () => {
  it("offers nothing without a selection", () => {
    expect(bulkActions([])).toEqual([]);
  });

  it("offers move, discard and propose for open entries", () => {
    expect(bulkActions([{ state: "collected" }, { state: "reviewing" }])).toEqual([
      "move",
      "discard",
      "propose",
    ]);
  });

  it("offers permanent deletion only when every entry is discarded", () => {
    expect(bulkActions([{ state: "discarded" }, { state: "discarded" }])).toEqual(["remove"]);
  });

  it("offers nothing for a mixed selection", () => {
    expect(bulkActions([{ state: "collected" }, { state: "discarded" }])).toEqual([]);
    expect(bulkActions([{ state: "collected" }, { state: "admitted" }])).toEqual([]);
  });

  it("drops propose above the review limit", () => {
    const many = Array.from({ length: BULK_PROPOSE_LIMIT + 1 }, () => ({
      state: "collected" as const,
    }));
    expect(bulkActions(many)).toEqual(["move", "discard"]);
  });
});

describe("isSelectable", () => {
  it("excludes admitted entries", () => {
    expect(isSelectable({ state: "admitted" })).toBe(false);
    expect(isSelectable({ state: "discarded" })).toBe(true);
  });
});

describe("group keys", () => {
  it("reads only a nonempty string", () => {
    expect(entryGroupKey({ group_key: "site:example.com" })).toBe("site:example.com");
    expect(entryGroupKey({ group_key: " " })).toBeNull();
    expect(entryGroupKey({ group_key: 3 })).toBeNull();
    expect(entryGroupKey(null)).toBeNull();
  });

  it("labels sites, repositories and tags", () => {
    expect(groupLabel("site:example.com", "Other")).toBe("example.com");
    expect(groupLabel("repo:org/repo", "Other")).toBe("org/repo");
    expect(groupLabel("tag:billing", "Other")).toBe("#billing");
    expect(groupLabel(null, "Other")).toBe("Other");
    expect(groupLabel("site:", "Other")).toBe("Other");
  });
});

describe("runBulk", () => {
  it("counts done items and conflicts and rethrows other failures", async () => {
    const conflict = new Error("conflict");
    const outcome = await runBulk(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw conflict;
      },
      (e) => e === conflict,
    );
    expect(outcome).toEqual({ done: 2, conflicts: 1 });
    await expect(
      runBulk(
        [1],
        async () => {
          throw new Error("boom");
        },
        () => false,
      ),
    ).rejects.toThrow("boom");
  });
});
