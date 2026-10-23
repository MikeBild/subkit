import { expect, test } from "bun:test";
import { AttentionV1Schema } from "../http/routes/operator/attention-schema.ts";
import { ATTENTION_SOURCES } from "./attention.ts";
import { INTAKE_CATEGORY_LIMIT, intakeCandidates } from "./attention-readers.ts";
import { attentionLine } from "./health-digest.ts";

test("collected intake is counted per category, largest first, with the total kept", () => {
  const [candidate, ...rest] = intakeCandidates([
    { category: "notes", count: 3, oldest: "2026-10-12T08:00:00.000Z" },
    { category: "blog-de", count: 60, oldest: new Date("2026-10-11T07:00:00.000Z") },
    { category: "articles", count: 3, oldest: null },
    { category: "radar", count: 38, oldest: "2026-10-13T09:00:00.000Z" },
  ]);
  expect(rest).toHaveLength(0);
  expect(candidate?.source).toBe("intake");
  const item = candidate?.item;
  expect(item?.counts).toEqual({
    intake: 104,
    intake_by_category: [
      { category: "blog-de", count: 60 },
      { category: "radar", count: 38 },
      { category: "articles", count: 3 },
      { category: "notes", count: 3 },
    ],
  });
  expect(item?.since).toBe("2026-10-11T07:00:00.000Z");
  expect(item?.actions).toEqual([
    {
      verb: "review",
      href: "/cockpit/intake?category=all",
      primary: true,
      permission: "intake:read",
    },
  ]);
  if (!item) throw new Error("missing intake item");
  const feed = AttentionV1Schema.parse({
    schema_version: "attention.v1",
    generated_at: "2026-10-14T00:00:00.000Z",
    sources: Object.fromEntries(ATTENTION_SOURCES.map((source) => [source, "answered"])),
    status: null,
    items: [item],
  });
  expect(feed.items[0]?.counts).toEqual(item.counts);
  expect(attentionLine(item)).toBe(
    "- [decide] intake_items: intake collected (104 collected items to review, by category: blog-de 60 | radar 38 | articles 3 | other 3)",
  );
});

test("categories beyond the limit are summed, not listed", () => {
  const rows = Array.from({ length: INTAKE_CATEGORY_LIMIT + 2 }, (_, index) => ({
    category: `c${String(index).padStart(2, "0")}`,
    count: 1,
    oldest: null,
  }));
  const counts = intakeCandidates(rows)[0]?.item.counts;
  expect(counts?.intake).toBe(INTAKE_CATEGORY_LIMIT + 2);
  expect(counts?.intake_by_category).toHaveLength(INTAKE_CATEGORY_LIMIT);
  expect(counts?.intake_categories_omitted).toBe(2);
});

test("nothing awaiting review yields no attention item", () => {
  expect(intakeCandidates([])).toEqual([]);
  expect(intakeCandidates([{ category: "notes", count: 0, oldest: null }])).toEqual([]);
});
