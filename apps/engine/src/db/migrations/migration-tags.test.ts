import { describe, expect, test } from "bun:test";
import {
  RETIRED_BASELINE_TAGS,
  SQUASHED_CHAIN_HEAD_TAG,
  splitLineage,
  stopsBeforeChainHead,
} from "../migrate.ts";
import journal from "./meta/_journal.json" with { type: "json" };

const tags = journal.entries.map((entry) => entry.tag);
const baselineTag = journal.entries.find((entry) => entry.idx === 0)?.tag;

const rows = (...list: Array<string | null>) =>
  list.map((tag, position) => ({ id: position + 1, hash: `hash-${position}`, tag }));

describe("migration tags", () => {
  test("keeps conversation visibility before active file content uniqueness", () => {
    const visibility = tags.indexOf("0009_conversation_visibility");
    const activeContent = tags.findIndex((tag) => tag.endsWith("_files_active_content_unique"));
    expect(visibility).toBeGreaterThan(0);
    expect(activeContent).toBeGreaterThan(visibility);
  });

  test("every tag in the journal is unique and the journal starts with the baseline", () => {
    expect(new Set(tags).size).toBe(tags.length);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(tags.map((_, idx) => idx));
    expect(baselineTag).toStartWith("0000_");
  });

  test("no tag reuses a retired baseline or the head of the replaced chain", () => {
    for (const tag of tags) {
      expect(RETIRED_BASELINE_TAGS).not.toContain(tag);
      expect(tag).not.toBe(SQUASHED_CHAIN_HEAD_TAG);
    }
    expect(new Set(RETIRED_BASELINE_TAGS).size).toBe(RETIRED_BASELINE_TAGS.length);
  });
});

describe("lineage split", () => {
  test("rows before the current baseline are history, even when their tag comes back", () => {
    const history = rows(null, "0000_old", SQUASHED_CHAIN_HEAD_TAG, "0001_reused");
    const lineage = splitLineage(
      [...history, ...rows("0000_new", "0001_reused").map((r, i) => ({ ...r, id: 10 + i }))],
      "0000_new",
    );
    expect(lineage.history.map((r) => r.tag)).toEqual([
      null,
      "0000_old",
      SQUASHED_CHAIN_HEAD_TAG,
      "0001_reused",
    ]);
    expect(lineage.current.map((r) => r.tag)).toEqual(["0000_new", "0001_reused"]);
  });

  test("before the stamp everything up to the chain head is history", () => {
    const lineage = splitLineage(
      rows("0000_old", SQUASHED_CHAIN_HEAD_TAG, "9998_after_the_head"),
      "0000_new",
    );
    expect(lineage.history.map((r) => r.tag)).toEqual(["0000_old", SQUASHED_CHAIN_HEAD_TAG]);
    expect(lineage.current.map((r) => r.tag)).toEqual(["9998_after_the_head"]);
  });

  test("without baseline and chain head every row is current", () => {
    expect(splitLineage(rows("0000_foreign"), "0000_new").current).toHaveLength(1);
  });

  test("a retired baseline without the chain head stops before it", () => {
    const retired = RETIRED_BASELINE_TAGS[0] ?? "0000_retired";
    expect(stopsBeforeChainHead(rows(retired, "0001_old"), baselineTag)).toBe(
      RETIRED_BASELINE_TAGS.length > 0,
    );
    expect(stopsBeforeChainHead(rows(retired, SQUASHED_CHAIN_HEAD_TAG), baselineTag)).toBe(false);
    expect(stopsBeforeChainHead(rows(retired, baselineTag ?? null), baselineTag)).toBe(false);
    expect(stopsBeforeChainHead(rows("0000_from_a_newer_release"), baselineTag)).toBe(false);
    expect(stopsBeforeChainHead([], baselineTag)).toBe(false);
  });
});
