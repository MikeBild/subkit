import { describe, expect, test } from "bun:test";
import { DEFAULT_EXPORT_LABELS, type ExportLabels, exportMarkdown } from "./export-markdown.ts";

const labels: ExportLabels = {
  title: "My notes",
  empty: "No notes yet.",
  quote: "You wrote",
  status: { confirmed: "Confirmed", learned: "Learned", mentioned_once: "Mentioned once" },
  area: {
    about: "About you",
    preferences: "Preferences",
    people: "People",
    routines: "Routines",
    lessons: "Lessons",
  },
};

describe("exportMarkdown", () => {
  test("an empty list says so", () => {
    expect(exportMarkdown([], labels)).toBe("# My notes\n\nNo notes yet.\n");
  });

  test("without labels the headings are English", () => {
    const out = exportMarkdown([
      { area: "about", status: "learned", text: "Works in Berlin.", quotes: ["I work in Berlin"] },
    ]);
    expect(out).toBe(
      [
        `# ${DEFAULT_EXPORT_LABELS.title}`,
        "",
        "## Learned",
        "",
        "### About you",
        "",
        "- Works in Berlin.",
        "  > You wrote: I work in Berlin",
        "",
      ].join("\n"),
    );
    expect(exportMarkdown([])).toContain(DEFAULT_EXPORT_LABELS.empty);
  });

  test("a label cannot add lines or heading levels of its own", () => {
    const out = exportMarkdown(
      [{ area: "about", status: "learned", text: "Works in Berlin.", quotes: ["yes"] }],
      {
        ...labels,
        title: "## My\nnotes",
        quote: "You\nwrote",
        status: { ...labels.status, learned: "# Learned\n# Injected" },
        area: { ...labels.area, about: "#### About" },
      },
    );
    expect(out.split("\n")).toEqual([
      "# My notes",
      "",
      "## Learned # Injected",
      "",
      "### About",
      "",
      "- Works in Berlin.",
      "  > You wrote: yes",
      "",
    ]);
  });

  test("groups by status, confirmed first, then by area, with the quotes under each note", () => {
    const out = exportMarkdown(
      [
        { area: "routines", status: "mentioned_once", text: "Walks at noon.", quotes: [] },
        {
          area: "preferences",
          status: "confirmed",
          text: "Prefers short\nanswers.",
          quotes: ["keep it  short", "short please"],
        },
        {
          area: "about",
          status: "confirmed",
          text: "Works in Berlin.",
          quotes: ["I work in Berlin"],
        },
        { area: "people", status: "learned", text: "Ana does the books.", quotes: [] },
      ],
      labels,
    );
    expect(out).toBe(
      [
        "# My notes",
        "",
        "## Confirmed",
        "",
        "### About you",
        "",
        "- Works in Berlin.",
        "  > You wrote: I work in Berlin",
        "",
        "### Preferences",
        "",
        "- Prefers short answers.",
        "  > You wrote: keep it short",
        "  > You wrote: short please",
        "",
        "## Learned",
        "",
        "### People",
        "",
        "- Ana does the books.",
        "",
        "## Mentioned once",
        "",
        "### Routines",
        "",
        "- Walks at noon.",
        "",
      ].join("\n"),
    );
  });
});
