import { describe, expect, test } from "bun:test";
import {
  DOCS_SECTION_IDS,
  DOCS_SECTIONS,
  DocsBundleSchema,
  LLMS_PAGE_PATHS,
  type LlmsPage,
  renderLlmsIndex,
} from "../llms-index.ts";

const pages: LlmsPage[] = [
  { path: "setup.md", title: "sk", summary: "Run the engine." },
  { path: "cli.md", title: "sk CLI reference", summary: "" },
];

describe("renderLlmsIndex", () => {
  const out = renderLlmsIndex(pages, {
    linkFor: (p) => `https://x/llms/${p.path}`,
    fullUrl: "https://x/llms-full.txt",
  });

  test("starts with the H1 and a `>` lede carrying the full-text pointer", () => {
    expect(out.startsWith("# sk\n")).toBe(true);
    expect(out).toContain("> All pages in one file: https://x/llms-full.txt");
  });

  test("lists every page through linkFor, with its summary when present", () => {
    expect(out).toContain("- [sk](https://x/llms/setup.md): Run the engine.");
    expect(out).toContain("- [sk CLI reference](https://x/llms/cli.md)\n".trimEnd());
  });

  test("the served page set is fixed and starts with setup", () => {
    expect(LLMS_PAGE_PATHS[0]).toBe("setup.md");
  });
});

describe("DocsBundleSchema", () => {
  const content = {
    title: "t",
    summary: "s",
    headings: [{ depth: 1, text: "t", anchor: "t" }],
    images: [],
    sha256: "x",
    body: "b",
  };
  const bundle = () => ({
    locales: ["en", "de"],
    sections: DOCS_SECTIONS,
    pages: [
      {
        slug: "a",
        llms_path: null,
        audience: "public",
        section: "start",
        order: 1,
        generated: false,
        locales: { en: content, de: content },
      },
    ],
  });

  test("accepts a minimal bundle", () => {
    expect(DocsBundleSchema.safeParse(bundle()).success).toBe(true);
  });

  test("rejects an unknown audience", () => {
    const b = bundle();
    const result = DocsBundleSchema.safeParse({
      ...b,
      pages: b.pages.map((p) => ({ ...p, audience: "internal" })),
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown section", () => {
    const b = bundle();
    const result = DocsBundleSchema.safeParse({
      ...b,
      pages: b.pages.map((p) => ({ ...p, section: "misc" })),
    });
    expect(result.success).toBe(false);
  });

  test("rejects a page without a section", () => {
    const b = bundle();
    const result = DocsBundleSchema.safeParse({
      ...b,
      pages: b.pages.map(({ section: _section, ...p }) => p),
    });
    expect(result.success).toBe(false);
  });

  test("rejects a bundle without section metadata", () => {
    const { sections: _sections, ...b } = bundle();
    expect(DocsBundleSchema.safeParse(b).success).toBe(false);
  });

  test("rejects an unknown locale", () => {
    const b = bundle();
    b.locales = ["en", "fr"];
    expect(DocsBundleSchema.safeParse(b).success).toBe(false);
  });

  test("rejects a page missing de", () => {
    const b = bundle();
    const result = DocsBundleSchema.safeParse({
      ...b,
      pages: b.pages.map((p) => ({ ...p, locales: { en: content } })),
    });
    expect(result.success).toBe(false);
  });
});

describe("DOCS_SECTIONS", () => {
  test("defines every section once, in reading order, in both locales", () => {
    expect(DOCS_SECTIONS.map((s) => s.id)).toEqual([...DOCS_SECTION_IDS]);
    expect(DOCS_SECTION_IDS).toEqual(["start", "work", "operate", "reference"]);
    for (const section of DOCS_SECTIONS) {
      for (const text of [section.locales.en, section.locales.de]) {
        expect(text.title.trim(), section.id).not.toBe("");
        expect(text.description.trim(), section.id).not.toBe("");
        expect(text.description.includes("\n"), section.id).toBe(false);
      }
    }
  });
});
