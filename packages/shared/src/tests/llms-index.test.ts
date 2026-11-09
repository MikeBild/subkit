import { describe, expect, test } from "bun:test";
import {
  DOCS_SECTION_IDS,
  DOCS_SECTIONS,
  DocsBundleSchema,
  docsSectionRank,
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
    expect(out.startsWith("# SubKit\n")).toBe(true);
    expect(out).toContain("> All pages in one file: https://x/llms-full.txt");
  });

  test("lists every page through linkFor, with its summary when present", () => {
    expect(out).toContain("- [sk](https://x/llms/setup.md): Run the engine.");
    expect(out).toContain("- [sk CLI reference](https://x/llms/cli.md)\n".trimEnd());
  });

  test("the served page set is fixed and starts with setup", () => {
    expect(LLMS_PAGE_PATHS).toEqual([
      "setup.md",
      "coding-agents.md",
      "cli.md",
      "settings.md",
      "connectors.md",
      "transactional-email.md",
    ]);
  });

  test("renders the complete transport format, including a missing summary", () => {
    expect(out).toBe(
      [
        "# SubKit",
        "",
        "> A self-hosted engine for governed workflows. These pages describe setup, coding-agent briefings and hooks, the sk CLI, runtime settings, the connector catalog, and governed transactional email.",
        "> All pages in one file: https://x/llms-full.txt",
        "",
        "## Pages",
        "",
        "- [sk](https://x/llms/setup.md): Run the engine.",
        "- [sk CLI reference](https://x/llms/cli.md)",
      ].join("\n"),
    );
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

  test("enforces every nested locale field and the exact image/build constraints", () => {
    const invalid = (change: (page: Record<string, unknown>) => Record<string, unknown>) => {
      const b = bundle();
      return DocsBundleSchema.safeParse({ ...b, pages: [change(b.pages[0] as never)] }).success;
    };
    expect(invalid((page) => ({ ...page, locales: {} }))).toBe(false);
    expect(
      invalid((page) => ({
        ...page,
        locales: { en: { ...content, headings: [{}] }, de: content },
      })),
    ).toBe(false);
    expect(
      invalid((page) => ({
        ...page,
        locales: {
          en: { ...content, images: [{ src: "x", alt: "a", build: "1.2" }] },
          de: content,
        },
      })),
    ).toBe(false);
    expect(
      invalid((page) => ({
        ...page,
        locales: { en: { ...content, images: [{ src: "x", alt: "a", width: 0 }] }, de: content },
      })),
    ).toBe(false);
    expect(invalid((page) => ({ ...page, path_choice: "Not-valid" }))).toBe(false);
    expect(invalid((page) => ({ ...page, path_choice: "valid-path" }))).toBe(true);
  });

  test("requires complete section, page, and locale object shapes", () => {
    const b = bundle();
    const page = b.pages[0];
    const invalid = (candidate: unknown) =>
      expect(DocsBundleSchema.safeParse(candidate).success).toBe(false);
    invalid({ ...b, sections: [{}] });
    invalid({
      ...b,
      sections: [
        { id: "start", locales: { en: { title: "x" }, de: { title: "x", description: "y" } } },
      ],
    });
    invalid({ ...b, pages: [{ ...page, slug: 1 }] });
    invalid({ ...b, pages: [{ ...page, llms_path: 1 }] });
    invalid({ ...b, pages: [{ ...page, order: 1.5 }] });
    invalid({ ...b, pages: [{ ...page, generated: "false" }] });
    invalid({
      ...b,
      pages: [
        {
          ...page,
          locales: {
            en: { ...content, headings: [{ depth: 1.5, text: "x", anchor: "x" }] },
            de: content,
          },
        },
      ],
    });
  });

  test("accepts only three numeric build components and a complete lowercase path choice", () => {
    const b = bundle();
    const build = (value: string) =>
      DocsBundleSchema.safeParse({
        ...b,
        pages: [
          {
            ...b.pages[0],
            path_choice: "a-1-z",
            locales: {
              en: { ...content, images: [{ src: "x", alt: "x", build: value }] },
              de: content,
            },
          },
        ],
      }).success;
    for (const value of ["0.0.0", "12.345.6789"]) expect(build(value), value).toBe(true);
    for (const value of ["1.2", "1.2.3x", "x1.2.3", "x.2.3", "1.x.3", "1.2.x", "1.2.3.4"])
      expect(build(value), value).toBe(false);
  });

  test("accepts exactly the published audiences and complete path choices", () => {
    const b = bundle();
    const page = b.pages[0];
    const parses = (changes: Record<string, unknown>) =>
      DocsBundleSchema.safeParse({ ...b, pages: [{ ...page, ...changes }] }).success;
    for (const audience of ["public", "operator"])
      expect(parses({ audience }), audience).toBe(true);
    expect(parses({ audience: "" })).toBe(false);
    for (const path_choice of ["a", "a-1-z"])
      expect(parses({ path_choice }), path_choice).toBe(true);
    for (const path_choice of ["a-1-z!", "a\n", "a/child"])
      expect(parses({ path_choice }), path_choice).toBe(false);
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

  test("ranks every declared section in reading order", () => {
    expect([...DOCS_SECTION_IDS].map(docsSectionRank)).toEqual([0, 1, 2, 3]);
  });
});
