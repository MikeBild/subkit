import { describe, expect, test } from "bun:test";
import type { SourceView } from "@/features/knowledge/model/knowledge";
import {
  type SourceFilter,
  sectionTotal,
  sourceGroupKey,
  visibleSources,
} from "@/features/knowledge/model/source-list-model";

function view(over: Partial<SourceView>): SourceView {
  return {
    id: "s",
    name: "Handbuch",
    kind: "url",
    status: "active",
    category: "ops",
    url: null,
    sections: 1,
    ingested: "2026-11-20T10:00:00Z",
    created: "2026-11-20T10:00:00Z",
    scheduled: false,
    error: null,
    describedBy: "human",
    ...over,
  };
}

const all: SourceFilter = {
  category: "all",
  createdBy: "all",
  q: "",
  sort: { key: "", order: "asc" },
};
const kindLabel = (kind: SourceView["kind"]) => `kind:${kind}`;
const names = (rows: SourceView[]) => rows.map((x) => x.name);

describe("the sources list", () => {
  const rows = [
    view({ id: "a", name: "Preise", kind: "text", category: "sales", sections: 4 }),
    view({ id: "b", name: "API", kind: "api", describedBy: "llm", sections: 2 }),
    view({ id: "c", name: "Handbuch", url: "https://docs.example.com", sections: 3 }),
  ];

  test("keeps the server order when nothing is filtered or sorted", () => {
    expect(names(visibleSources(rows, all, kindLabel))).toEqual(["Preise", "API", "Handbuch"]);
  });

  test("filters by category and by who described the source", () => {
    expect(names(visibleSources(rows, { ...all, category: "sales" }, kindLabel))).toEqual([
      "Preise",
    ]);
    expect(names(visibleSources(rows, { ...all, createdBy: "ai" }, kindLabel))).toEqual(["API"]);
    expect(names(visibleSources(rows, { ...all, createdBy: "person" }, kindLabel))).toEqual([
      "Preise",
      "Handbuch",
    ]);
  });

  test("search matches the name, the address and the localized kind", () => {
    expect(names(visibleSources(rows, { ...all, q: "docs.example" }, kindLabel))).toEqual([
      "Handbuch",
    ]);
    expect(names(visibleSources(rows, { ...all, q: "kind:text" }, kindLabel))).toEqual(["Preise"]);
  });

  test("sorts by a known column and ignores an unknown one", () => {
    const bySections = { ...all, sort: { key: "sections", order: "desc" as const } };
    expect(names(visibleSources(rows, bySections, kindLabel))).toEqual([
      "Preise",
      "Handbuch",
      "API",
    ]);
    const unknown = { ...all, sort: { key: "nope", order: "desc" as const } };
    expect(names(visibleSources(rows, unknown, kindLabel))).toEqual(names(rows));
  });

  test("groups by category, status or kind with the given labels, and not at all otherwise", () => {
    const labels = {
      category: (c: string) => `cat:${c}`,
      status: (s: SourceView["status"]) => `status:${s}`,
      kind: kindLabel,
    };
    const row = view({ category: "ops", status: "off", kind: "file" });
    expect(sourceGroupKey("category", labels)?.(row)).toBe("cat:ops");
    expect(sourceGroupKey("status", labels)?.(row)).toBe("status:off");
    expect(sourceGroupKey("kind", labels)?.(row)).toBe("kind:file");
    expect(sourceGroupKey("all", labels)).toBeNull();
  });

  test("counts the sections of the shown sources", () => {
    expect(sectionTotal(rows)).toBe(9);
    expect(sectionTotal([])).toBe(0);
  });
});
