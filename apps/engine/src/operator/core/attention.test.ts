import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  ATTENTION_SOURCES,
  type AttentionItem,
  type AttentionV1,
  attentionAllClear,
  compareAttentionItems,
  projectAttentionItems,
} from "./attention.ts";

const item = (id: string): AttentionItem => ({
  id,
  class: "decide",
  severity: "notice",
  kind: "workflow",
  subject: null,
  reason: "approval_expiring",
  trigger: null,
  cause_class: null,
  counts: {},
  since: null,
  deadline: null,
  detail: null,
  actions: [],
});
const sources = Object.fromEntries(
  ATTENTION_SOURCES.map((source) => [source, "answered"]),
) as AttentionV1["sources"];
const empty: AttentionV1 = {
  schema_version: "attention.v1",
  generated_at: "2026-11-09T00:00:00.000Z",
  sources,
  status: null,
  items: [],
};

test("all-clear requires no items and no failed source, even when some sources are not permitted", () => {
  expect(attentionAllClear(empty)).toBe(true);
  expect(attentionAllClear({ ...empty, items: [item("task")] })).toBe(false);
  for (const source of ATTENTION_SOURCES) {
    expect(attentionAllClear({ ...empty, sources: { ...sources, [source]: "failed" } })).toBe(
      false,
    );
    expect(
      attentionAllClear({ ...empty, sources: { ...sources, [source]: "not_permitted" } }),
    ).toBe(true);
  }
});

test("redacting hook names cannot modify cached facts or another caller's authorized view", () => {
  const hook = Object.freeze({
    ...item("hook"),
    trigger: Object.freeze({ kind: "inbound_hook" as const, name: "private hook" }),
  });
  const scheduled = Object.freeze({
    ...item("schedule"),
    trigger: Object.freeze({ kind: "schedule" as const, name: "morning" }),
  });
  const values = Object.freeze([scheduled, hook, Object.freeze(item("plain"))]);
  const before = JSON.stringify(values);
  expect(
    projectAttentionItems(values, false).find((entry) => entry.id === "hook")?.trigger,
  ).toEqual({ kind: "inbound_hook", name: null });
  expect(
    projectAttentionItems(values, false).find((entry) => entry.id === "schedule")?.trigger?.name,
  ).toBe("morning");
  expect(
    projectAttentionItems(values, true).find((entry) => entry.id === "hook")?.trigger?.name,
  ).toBe("private hook");
  expect(JSON.stringify(values)).toBe(before);
});

test("comparator handles both orders of missing dates and equal IDs", () => {
  const a = item("a");
  const b = item("b");
  expect(compareAttentionItems(a, a)).toBe(0);
  expect(compareAttentionItems(a, b)).toBe(-1);
  expect(compareAttentionItems(b, a)).toBe(1);
  for (const key of ["deadline", "since"] as const) {
    expect(compareAttentionItems(a, { ...b, [key]: "2026-01-01" })).toBe(1);
    expect(compareAttentionItems({ ...a, [key]: "2026-01-01" }, b)).toBe(-1);
    expect(
      compareAttentionItems({ ...a, [key]: "2026-01-01" }, { ...b, [key]: "2026-02-01" }),
    ).toBe(-1);
    expect(
      compareAttentionItems({ ...a, [key]: "2026-02-01" }, { ...b, [key]: "2026-01-01" }),
    ).toBe(1);
  }
});

test("projected order is deterministic and idempotent without mutating source order", () => {
  fc.assert(
    fc.property(fc.uniqueArray(fc.string(), { maxLength: 30 }), (ids) => {
      const items = Object.freeze(ids.map((id) => Object.freeze(item(id))));
      const before = JSON.stringify(items);
      const projected = projectAttentionItems(items, true);
      expect(projectAttentionItems([...items].reverse(), true)).toEqual(projected);
      expect(projectAttentionItems(projected, true)).toEqual(projected);
      expect(JSON.stringify(items)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("missing dates sort after present year-only timestamps", () => {
  for (const key of ["deadline", "since"] as const) {
    const absent = item("absent");
    const present = { ...item("present"), [key]: "2026" };
    expect(compareAttentionItems(absent, present)).toBe(1);
    expect(compareAttentionItems(present, absent)).toBe(-1);
  }
});

test("equal present dates defer to the remaining date and stable ID order", () => {
  const a = { ...item("a"), deadline: "2026-01-01", since: "2025-01-01" };
  const b = { ...item("b"), deadline: "2026-01-01", since: "2025-01-01" };
  expect(compareAttentionItems(a, b)).toBe(-1);
  expect(compareAttentionItems(b, a)).toBe(1);
  expect(compareAttentionItems(a, a)).toBe(0);
});
