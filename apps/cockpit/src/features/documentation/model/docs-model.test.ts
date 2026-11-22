import { describe, expect, test } from "bun:test";
import { DOCS_SECTIONS, type DocsBundle, type DocsSectionId } from "@shared/llms-index";
import { DOCS } from "@/app/docs-bundle";
import { docsHref } from "@/app/links";
import {
  activeHeading,
  anchorFor,
  article,
  docsEntries,
  docsRows,
  docsSections,
  filterRows,
  findPage,
  headingLevel,
  headingSlug,
  imageFor,
  localized,
  neighbours,
  orderedPages,
  releaseVersion,
  resolveLink,
  safeDecode,
  tableOfContents,
} from "@/features/documentation/model/docs-model";

type Content = DocsBundle["pages"][number]["locales"]["en"];

function content(title: string, body: string, headings: Content["headings"] = []): Content {
  return { title, summary: `${title} summary`, body, headings, images: [], sha256: "x" };
}

function page(
  slug: string,
  order: number,
  audience: "public" | "operator",
  en: Content,
  de: Content = en,
  llms_path: string | null = "setup.md",
  section: DocsSectionId = "start",
): DocsBundle["pages"][number] {
  return { slug, order, audience, section, llms_path, generated: false, locales: { en, de } };
}

function withoutChoice(entry: DocsBundle["pages"][number]): DocsBundle["pages"][number] {
  const { path_choice: _choice, ...rest } = entry as DocsBundle["pages"][number] & {
    path_choice?: string;
  };
  return rest;
}

function hostingChoice(): DocsBundle {
  const en = content("x", "## x");
  const choice = (entry: DocsBundle["pages"][number]) =>
    ({ ...entry, path_choice: "hosting" }) as DocsBundle["pages"][number];
  return {
    locales: ["en", "de"],
    sections: [...DOCS_SECTIONS],
    pages: [
      page("intro", 1, "public", en),
      choice(page("cloud", 2, "public", en)),
      choice(page("engine", 3, "operator", en)),
      page("setup", 4, "operator", en),
      page("first", 5, "public", en),
      page("clipper", 1, "public", en, en, "setup.md", "work"),
    ],
  };
}

const FIXTURE: DocsBundle = {
  locales: ["en", "de"],
  sections: [...DOCS_SECTIONS],
  pages: [
    page(
      "operate",
      1,
      "operator",
      content("Run the engine", "## Run the engine\n\nStart it.\n\n### Backups\n\nNightly.", [
        { depth: 2, text: "Run the engine", anchor: "run-the-engine" },
        { depth: 3, text: "Backups", anchor: "backups" },
      ]),
      content("Die Engine betreiben", "## Die Engine betreiben\n\nStarte sie.", [
        { depth: 2, text: "Die Engine betreiben", anchor: "die-engine-betreiben" },
      ]),
      undefined,
      "operate",
    ),
    page(
      "clipper",
      1,
      "public",
      content(
        "Web Clipper",
        "## Web Clipper\n\nCollect pages.\n\n### Install the `clipper`\n\nRun it.\n\n### Review\n\nIn chat.",
        [
          { depth: 2, text: "Web Clipper", anchor: "web-clipper" },
          { depth: 3, text: "Install the `clipper`", anchor: "install-the-clipper" },
          { depth: 3, text: "Review", anchor: "review" },
        ],
      ),
      content("", ""),
      "setup.md",
      "work",
    ),
  ],
};

describe("docs model", () => {
  test("groups chapters into the reading sections and numbers each section's steps", () => {
    expect(orderedPages(FIXTURE).map((p) => p.slug)).toEqual(["clipper", "operate"]);
    const en = content("x", "## x");
    const bundle: DocsBundle = {
      locales: ["en", "de"],
      sections: [...DOCS_SECTIONS],
      pages: [
        page("cli", 1, "public", en, en, "cli.md", "reference"),
        page("setup", 2, "operator", en, en, "setup.md", "start"),
        page("intro", 1, "public", en, en, "setup.md", "start"),
        page("branding", 1, "operator", en, en, "setup.md", "operate"),
      ],
    };
    const groups = docsSections(bundle, "de", docsRows(bundle, "de"));
    expect(groups.map((group) => group.id)).toEqual(["start", "operate", "reference"]);
    expect(groups[0]?.title).toBe("Erste Schritte");
    expect(groups[0]?.description).toContain("in dieser Reihenfolge");
    expect(groups[0]?.rows.map((row) => [row.slug, row.step])).toEqual([
      ["intro", 1],
      ["setup", 2],
    ]);
    expect(docsSections(bundle, "en", [])).toEqual([]);
  });

  test("previous and next walk every chapter once in reading order", () => {
    const linear: DocsBundle = { ...DOCS, pages: DOCS.pages.map(withoutChoice) };
    const ordered = orderedPages(linear).map((p) => p.slug);
    const first = ordered[0] ?? "";
    expect(neighbours(linear, first).previous).toBeNull();
    expect(neighbours(linear, ordered.at(-1) ?? "").next).toBeNull();
    const visited = [first];
    let next = neighbours(linear, first).next;
    while (next) {
      expect(neighbours(linear, next.slug).previous?.slug).toBe(visited.at(-1));
      visited.push(next.slug);
      next = neighbours(linear, next.slug).next;
    }
    expect(visited).toEqual(ordered);
    expect(new Set(visited).size).toBe(linear.pages.length);
    expect(neighbours(linear, "missing")).toEqual({ previous: null, next: null, choice: null });
  });

  test("the shipped learning path starts with what SubKit is and numbers its steps", () => {
    const [start] = docsSections(DOCS, "de", docsRows(DOCS, "de"));
    expect(start?.id).toBe("start");
    expect(start?.rows[0]?.slug).toBe("intro");
    const steps = start?.entries.map((entry) =>
      entry.kind === "choice" ? entry.step : entry.row.step,
    );
    expect(steps).toEqual(steps?.map((_, index) => index + 1));
  });

  test("chapters sharing a path choice form one step and branch the reading order", () => {
    const bundle = hostingChoice();
    const rows = docsRows(bundle, "de");
    expect(rows.map((row) => [row.slug, row.step])).toEqual([
      ["intro", 1],
      ["cloud", 2],
      ["engine", 2],
      ["setup", 3],
      ["first", 4],
      ["clipper", 1],
    ]);
    const [start] = docsSections(bundle, "de", rows);
    expect(
      start?.entries.map((entry) =>
        entry.kind === "choice"
          ? [entry.id, entry.step, entry.rows.map((row) => row.slug)]
          : entry.row.slug,
      ),
    ).toEqual(["intro", ["hosting", 2, ["cloud", "engine"]], "setup", "first"]);
    const intro = neighbours(bundle, "intro");
    expect(intro.next?.slug).toBe("cloud");
    expect(intro.choice?.id).toBe("hosting");
    expect(intro.choice?.pages.map((p) => p.slug)).toEqual(["cloud", "engine"]);
    const cloud = neighbours(bundle, "cloud");
    expect([cloud.previous?.slug, cloud.next?.slug, cloud.choice]).toEqual([
      "intro",
      "first",
      null,
    ]);
    const engine = neighbours(bundle, "engine");
    expect([engine.previous?.slug, engine.next?.slug]).toEqual(["intro", "setup"]);
    expect(neighbours(bundle, "setup").previous?.slug).toBe("engine");
    expect(neighbours(bundle, "first").previous?.slug).toBe("setup");
    const filtered = docsSections(
      bundle,
      "de",
      rows.filter((row) => row.slug !== "engine"),
    )[0]?.entries.map((entry) => entry.kind);
    expect(filtered).toEqual(["chapter", "chapter", "chapter", "chapter"]);
    expect(docsEntries([])).toEqual([]);
  });

  test("the last heading becomes current once the article is scrolled to its end", () => {
    const positions = [
      { anchor: "a", top: -400 },
      { anchor: "b", top: 40 },
      { anchor: "c", top: 300 },
      { anchor: "d", top: 500 },
    ];
    expect(activeHeading(positions, 96, false)).toBe("b");
    expect(activeHeading(positions, 0, false)).toBe("a");
    expect(activeHeading(positions, 96, true)).toBe("d");
    expect(activeHeading(positions, 96, true, "c", 600)).toBe("c");
    expect(activeHeading(positions, 96, true, "a", 600)).toBe("d");
    expect(activeHeading([], 96, true)).toBeUndefined();
  });

  test("an article repeats its summary only when the body does not already say it", () => {
    for (const shipped of DOCS.pages)
      for (const locale of ["en", "de"] as const) {
        const doc = article(shipped, locale);
        if (doc.lead) expect(doc.body).not.toContain(doc.lead);
      }
    const said = page("a", 1, "public", content("A", "## A\n\nA summary goes `here`.", []));
    expect(article(said, "en").lead).toBeNull();
    const unsaid = page("b", 1, "public", content("B", "## B\n\nSomething else.", []));
    expect(article(unsaid, "en").lead).toBe("B summary");
  });

  test("orders chapters by section before their position within it", () => {
    const en = content("x", "## x");
    const bundle: DocsBundle = {
      locales: ["en", "de"],
      sections: [...DOCS_SECTIONS],
      pages: [
        page("cli", 1, "public", en, en, "cli.md", "reference"),
        page("branding", 1, "operator", en, en, "setup.md", "operate"),
        page("setup", 2, "operator", en, en, "setup.md", "start"),
        page("intro", 1, "public", en, en, "setup.md", "start"),
      ],
    };
    expect(orderedPages(bundle).map((p) => p.slug)).toEqual(["intro", "setup", "branding", "cli"]);
    expect(
      resolveLink(bundle, bundle.pages[0] as DocsBundle["pages"][number], "en", "setup.md"),
    ).toEqual({
      kind: "chapter",
      slug: "intro",
    });
  });

  test("searches title, summary and headings, case and accent insensitive", () => {
    const rows = docsRows(FIXTURE, "en");
    expect(filterRows(rows, "BACKUPS").map((row) => row.slug)).toEqual(["operate"]);
    expect(filterRows(rows, "clipper summary").map((row) => row.slug)).toEqual(["clipper"]);
    expect(filterRows(rows, "install clipper").map((row) => row.slug)).toEqual(["clipper"]);
    expect(filterRows(rows, "nothing here")).toEqual([]);
    expect(filterRows(docsRows(FIXTURE, "de"), "betreiben").map((r) => r.slug)).toEqual([
      "operate",
    ]);
    const accent = docsRows(
      {
        locales: ["en", "de"],
        sections: [...DOCS_SECTIONS],
        pages: [page("a", 1, "public", content("Übersicht", "## Übersicht", []))],
      },
      "de",
    );
    expect(filterRows(accent, "ubersicht")).toHaveLength(1);
  });

  test("falls back to English when the chosen locale has no content", () => {
    const clipper = findPage(FIXTURE, "clipper");
    expect(clipper && localized(clipper, "de").title).toBe("Web Clipper");
    const operate = findPage(FIXTURE, "operate");
    expect(operate && localized(operate, "de").title).toBe("Die Engine betreiben");
    expect(findPage(FIXTURE, "missing")).toBeNull();
  });

  test("strips the title heading and builds the table of contents below it", () => {
    const clipper = findPage(FIXTURE, "clipper");
    if (!clipper) throw new Error("fixture");
    const doc = article(clipper, "en");
    expect(doc.body.startsWith("Collect pages.")).toBe(true);
    expect(doc.toc.map((h) => h.anchor)).toEqual(["install-the-clipper", "review"]);
    expect(doc.titleDepth).toBe(2);
    expect(headingLevel(3, doc.titleDepth)).toBe(2);
    expect(headingLevel(4, doc.titleDepth)).toBe(3);
    expect(headingLevel(1, doc.titleDepth)).toBe(2);
  });

  test("a single shallow section brings its subsections into the table of contents", () => {
    expect(
      tableOfContents([
        { depth: 2, text: "Commands", anchor: "commands" },
        { depth: 3, text: "a", anchor: "a" },
        { depth: 4, text: "a b", anchor: "a-b" },
        { depth: 3, text: "c", anchor: "c" },
      ]).map((h) => h.anchor),
    ).toEqual(["commands", "a", "c"]);
    expect(tableOfContents([])).toEqual([]);
  });

  test("removes a title heading that follows an intro paragraph", () => {
    const generated = page(
      "cli",
      0,
      "public",
      content("subkit CLI reference", "Intro.\n\n# subkit CLI reference\n\n## Commands", [
        { depth: 1, text: "subkit CLI reference", anchor: "subkit-cli-reference" },
        { depth: 2, text: "Commands", anchor: "commands" },
      ]),
    );
    const doc = article(generated, "en");
    expect(doc.body).toBe("Intro.\n\n## Commands");
    expect(doc.toc.map((h) => h.anchor)).toEqual(["commands"]);
  });

  test("finds heading anchors from rendered heading text", () => {
    const clipper = findPage(FIXTURE, "clipper");
    if (!clipper) throw new Error("fixture");
    const { headings } = localized(clipper, "en");
    expect(anchorFor(headings, "Install the clipper")).toBe("install-the-clipper");
    expect(anchorFor(headings, " Review ")).toBe("review");
    expect(anchorFor(headings, "Unknown")).toBeUndefined();
    expect(headingSlug("Connector & recipe catalog")).toBe("connector--recipe-catalog");
  });

  test("every heading of the shipped documentation has a unique anchor its text resolves to", () => {
    for (const shipped of DOCS.pages) {
      for (const locale of ["en", "de"] as const) {
        const { headings } = shipped.locales[locale];
        const anchors = headings.map((h) => h.anchor);
        expect(new Set(anchors).size, `${shipped.slug}/${locale}`).toBe(anchors.length);
        for (const heading of headings)
          expect(headingSlug(heading.text), `${shipped.slug}/${locale}`).toBe(heading.anchor);
      }
    }
  });

  test("keeps chapter links inside the documentation and marks external links", () => {
    const current = findPage(FIXTURE, "clipper");
    if (!current) throw new Error("fixture");
    expect(resolveLink(FIXTURE, current, "en", "#review")).toEqual({
      kind: "anchor",
      anchor: "review",
    });
    expect(resolveLink(FIXTURE, current, "en", "setup.md#backups")).toEqual({
      kind: "chapter",
      slug: "operate",
      anchor: "backups",
    });
    expect(resolveLink(FIXTURE, current, "en", "/docs/operate")).toEqual({
      kind: "chapter",
      slug: "operate",
    });
    expect(resolveLink(FIXTURE, current, "en", "/docs/clipper#review")).toEqual({
      kind: "anchor",
      anchor: "review",
    });
    expect(resolveLink(FIXTURE, current, "en", "https://example.com/x")).toEqual({
      kind: "external",
      href: "https://example.com/x",
    });
    expect(resolveLink(FIXTURE, current, "en", "/docs/missing")).toEqual({
      kind: "chapter",
      slug: "missing",
    });
    expect(resolveLink(FIXTURE, current, "en", "other.md").kind).toBe("plain");
  });

  test("keeps internal addresses inside the cockpit router", () => {
    const current = findPage(FIXTURE, "clipper");
    if (!current) throw new Error("fixture");
    expect(resolveLink(FIXTURE, current, "en", "/docs")).toEqual({ kind: "route", href: "/docs" });
    expect(resolveLink(FIXTURE, current, "en", "/docs/")).toEqual({ kind: "route", href: "/docs" });
    expect(resolveLink(FIXTURE, current, "en", "/settings?tab=x")).toEqual({
      kind: "route",
      href: "/settings?tab=x",
    });
    expect(resolveLink(FIXTURE, current, "en", "image.png")).toEqual({
      kind: "plain",
      href: "image.png",
    });
  });

  test("malformed escapes degrade to the raw value instead of throwing", () => {
    const current = findPage(FIXTURE, "clipper");
    if (!current) throw new Error("fixture");
    expect(safeDecode("%E0%A4%A")).toBe("%E0%A4%A");
    expect(safeDecode("caf%C3%A9")).toBe("café");
    expect(resolveLink(FIXTURE, current, "en", "#%E0%A4%A")).toEqual({
      kind: "anchor",
      anchor: "%E0%A4%A",
    });
    expect(resolveLink(FIXTURE, current, "en", "/docs/%E0%A4%A")).toEqual({
      kind: "chapter",
      slug: "%E0%A4%A",
    });
    expect(() => resolveLink(FIXTURE, current, "en", "setup.md#%E0%A4%A")).not.toThrow();
  });

  test("builds chapter addresses and reads the release line", () => {
    expect(docsHref()).toBe("/docs");
    expect(docsHref("web-clipper")).toBe("/docs/web-clipper");
    expect(docsHref("web-clipper", "die-erweiterung-installieren")).toBe(
      "/docs/web-clipper#die-erweiterung-installieren",
    );
    expect(releaseVersion("v1.2.3")).toBe("1.2.3");
    expect(releaseVersion("1.2.3")).toBe("1.2.3");
    expect(releaseVersion("")).toBeNull();
    expect(releaseVersion(undefined)).toBeNull();
  });
});

describe("imageFor", () => {
  test("finds the image metadata for a rendered src in the reader's locale", () => {
    const en = content("Guide", "![Run](/docs-images/guide-run.en.webp?v=a)");
    const de = content("Anleitung", "![Run](/docs-images/guide-run.de.webp?v=b)");
    const page = {
      slug: "guide",
      llms_path: null,
      audience: "public",
      section: "start",
      order: 1,
      generated: false,
      locales: {
        en: {
          ...en,
          images: [{ src: "/docs-images/guide-run.en.webp?v=a", alt: "Run", build: "1.2.3" }],
        },
        de: {
          ...de,
          images: [{ src: "/docs-images/guide-run.de.webp?v=b", alt: "Run", width: 10 }],
        },
      },
    } as DocsBundle["pages"][number];
    expect(imageFor(page, "de", "/docs-images/guide-run.de.webp?v=b")).toEqual({
      src: "/docs-images/guide-run.de.webp?v=b",
      alt: "Run",
      width: 10,
    });
    expect(imageFor(page, "en", "/docs-images/guide-run.en.webp?v=a")?.build).toBe("1.2.3");
    expect(imageFor(page, "de", "/docs-images/guide-run.en.webp?v=a")).toBeNull();
  });
});
