import { describe, expect, test } from "bun:test";
import { type AttentionItem, compareAttentionItems } from "./core/attention.ts";

function item(
  id: string,
  klass: AttentionItem["class"],
  at: { since?: string | null; deadline?: string | null } = {},
): AttentionItem {
  return {
    id,
    class: klass,
    severity: "urgent",
    kind: "workflow",
    subject: null,
    reason: "failing",
    trigger: null,
    cause_class: null,
    counts: {},
    since: at.since ?? null,
    deadline: at.deadline ?? null,
    detail: null,
    actions: [],
  };
}

const order = (items: AttentionItem[]) => [...items].sort(compareAttentionItems).map((i) => i.id);

describe("Braucht dich order", () => {
  test("gestoppt before scheitert before entscheiden, whatever the deadline or age", () => {
    const items = [
      item("decide-due-now", "decide", { deadline: "2026-01-01T00:00:00.000Z" }),
      item("failing-new", "failing", { since: "2026-06-01T00:00:00.000Z" }),
      item("stopped-new", "stopped", { since: "2026-06-02T00:00:00.000Z" }),
      item("decide-old", "decide", { since: "2025-01-01T00:00:00.000Z" }),
      item("failing-old", "failing", { since: "2025-01-01T00:00:00.000Z" }),
    ];
    expect(order(items)).toEqual([
      "stopped-new",
      "failing-old",
      "failing-new",
      "decide-due-now",
      "decide-old",
    ]);
  });

  test("within a class the nearest deadline comes first, an entry with a deadline before one without", () => {
    const items = [
      item("no-deadline-oldest", "decide", { since: "2025-01-01T00:00:00.000Z" }),
      item("due-later", "decide", {
        since: "2026-05-01T00:00:00.000Z",
        deadline: "2026-07-02T00:00:00.000Z",
      }),
      item("due-sooner", "decide", {
        since: "2026-06-01T00:00:00.000Z",
        deadline: "2026-07-01T00:00:00.000Z",
      }),
    ];
    expect(order(items)).toEqual(["due-sooner", "due-later", "no-deadline-oldest"]);
  });

  test("without a deadline the oldest comes first, an entry without a date last", () => {
    const items = [
      item("undated", "stopped"),
      item("newer", "stopped", { since: "2026-06-02T00:00:00.000Z" }),
      item("older", "stopped", { since: "2026-06-01T00:00:00.000Z" }),
    ];
    expect(order(items)).toEqual(["older", "newer", "undated"]);
  });

  test("the order does not depend on the order the sources answered in", () => {
    const items = [
      item("a", "failing", { since: "2026-06-01T00:00:00.000Z" }),
      item("b", "stopped", { deadline: "2026-06-03T00:00:00.000Z" }),
      item("c", "decide"),
      item("d", "stopped", { since: "2026-06-01T00:00:00.000Z" }),
      item("e", "failing", { since: "2026-06-01T00:00:00.000Z" }),
    ];
    const expected = order(items);
    expect(order([...items].reverse())).toEqual(expected);
    expect(order([items[2], items[4], items[0], items[3], items[1]] as AttentionItem[])).toEqual(
      expected,
    );
    expect(expected).toEqual(["b", "d", "a", "e", "c"]);
  });
});
