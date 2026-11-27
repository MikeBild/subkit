import { describe, expect, test } from "bun:test";
import {
  type Attention,
  type AttentionItem,
  attentionEntries,
  entrySnapshot,
} from "@/features/overview";
import { item, NOW } from "@/features/overview/model/overview-model-fixtures";
import {
  attentionView,
  canReadAttention,
  inboxCount,
  withHidden,
  withoutHidden,
} from "./attention-model";
import { ATTENTION_READ_PERMISSIONS } from "./navigation";

describe("attention model", () => {
  test("any attention permission lets a person read the list", () => {
    for (const permission of ATTENTION_READ_PERMISSIONS)
      expect(canReadAttention([permission])).toBe(true);
    expect(canReadAttention([])).toBe(false);
  });

  test("hiding keeps the snapshot, restoring an unknown entry changes nothing", () => {
    const empty: ReadonlyMap<string, string> = new Map();
    const hidden = withHidden(empty, "a1", "snap-1");
    expect([...hidden]).toEqual([["a1", "snap-1"]]);
    expect(empty.size).toBe(0);
    expect(withHidden(hidden, "a1", "snap-2").get("a1")).toBe("snap-2");
    expect(withoutHidden(hidden, "missing")).toBe(hidden);
    expect(withoutHidden(hidden, "a1").size).toBe(0);
  });
});

describe("inboxCount", () => {
  test("counts the collected inbox entries the overview already knows", () => {
    expect(
      inboxCount([
        { reason: "intake_collected", counts: { intake: 8 } },
        { reason: "failing", counts: {} },
      ]),
    ).toBe(8);
  });

  test("an entry without a count stands for one, no entry for none", () => {
    expect(inboxCount([{ reason: "intake_collected", counts: {} }])).toBe(1);
    expect(inboxCount([])).toBe(0);
  });
});

describe("hidden entries, badge and list", () => {
  const entry = (id: string, counts: AttentionItem["counts"] = {}) =>
    item({ id, subject: { kind: "workflow", id, name: id }, counts });
  const server = (items: AttentionItem[]): Attention => ({
    schema_version: "attention.v1",
    generated_at: new Date(NOW).toISOString(),
    sources: {} as Attention["sources"],
    status: null,
    items,
    snoozed: [],
  });
  const agree = (data: Attention, hidden: ReadonlyMap<string, string>) => {
    const view = attentionView(data, hidden);
    const listed = attentionEntries(data.items, view.hidden);
    expect(view.badge?.count ?? 0).toBe(listed.length);
    return { view, listed: listed.map((listedItem) => listedItem.id) };
  };

  test("badge and list agree after a response, hiding, a changed entry and restoring", () => {
    const first = server([entry("a"), entry("b")]);
    let hidden: ReadonlyMap<string, string> = new Map();
    expect(agree(first, hidden).listed).toEqual(["a", "b"]);

    hidden = withHidden(hidden, "a", entrySnapshot(entry("a")));
    expect(agree(first, hidden).listed).toEqual(["b"]);

    const unchanged = server([entry("a"), entry("b")]);
    const stillHidden = agree(unchanged, hidden);
    expect(stillHidden.listed).toEqual(["b"]);
    expect(stillHidden.view.hidden).toBe(hidden);

    const changed = server([entry("a", { failures: 2 }), entry("b")]);
    const reappeared = agree(changed, hidden);
    expect(reappeared.listed).toEqual(["a", "b"]);
    expect(reappeared.view.hidden.size).toBe(0);

    hidden = withoutHidden(withHidden(hidden, "b", entrySnapshot(entry("b"))), "b");
    expect(agree(changed, hidden).listed).toEqual(["a", "b"]);
  });

  test("without a response yet there is no badge and hiding stays as it was", () => {
    const hidden = withHidden(new Map(), "a", "snap");
    expect(attentionView(undefined, hidden)).toEqual({ hidden, badge: null });
  });
});
