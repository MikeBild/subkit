import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCS_SECTION_IDS, DocsBundleSchema, LLMS_PAGE_PATHS } from "@shared/llms-index.ts";
import {
  byReadingPath,
  headingAnchors,
  headingCounts,
  loadChapters,
  repositoryReferences,
  summary,
} from "../docs-source.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-source-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function chapter(file: string, head: string, body = "## Body\n"): void {
  writeFileSync(join(dir, file), `---\n${head}\n---\n${body}`);
}

describe("loadChapters", () => {
  test("sorts by order and strips frontmatter", () => {
    chapter("b.en.md", "slug: b\nsection: start\norder: 2", "## B\n");
    chapter("a.en.md", "slug: a\nsection: start\norder: 1", "## A\n");
    const chapters = loadChapters(dir);
    expect(chapters.map((c) => c.slug)).toEqual(["a", "b"]);
    expect(chapters[0]?.body).toBe("## A\n");
  });

  test("rejects a duplicate slug", () => {
    chapter("a.en.md", "slug: x\nsection: start\norder: 1");
    chapter("b.en.md", "slug: x\nsection: start\norder: 2");
    expect(() => loadChapters(dir)).toThrow("duplicate chapter slug x");
  });

  test("rejects a missing order", () => {
    chapter("a.en.md", "slug: a\nsection: start");
    expect(() => loadChapters(dir)).toThrow("needs order");
  });

  test("reads the seed version of a seeded chapter", () => {
    chapter("a.en.md", "slug: a\nsection: start\norder: 1\nseed: sk-ref-a\nseed_version: 3");
    expect(loadChapters(dir)[0]?.seedVersion).toBe(3);
  });

  test("rejects a seeded chapter without a seed version", () => {
    chapter("a.en.md", "slug: a\nsection: start\norder: 1\nseed: sk-ref-a");
    expect(() => loadChapters(dir)).toThrow("needs seed_version");
  });

  test("rejects a seed version that is not a positive integer", () => {
    chapter("a.en.md", "slug: a\nsection: start\norder: 1\nseed: sk-ref-a\nseed_version: 0");
    expect(() => loadChapters(dir)).toThrow("positive integer seed_version");
  });

  test("rejects a missing section", () => {
    chapter("a.en.md", "slug: a\norder: 1");
    expect(() => loadChapters(dir)).toThrow("a.en.md needs section");
  });

  test("rejects an unknown section", () => {
    chapter("a.en.md", "slug: a\nsection: misc\norder: 1");
    expect(() => loadChapters(dir)).toThrow("a.en.md has unknown section misc");
  });

  test("rejects a duplicate order within a section", () => {
    chapter("a.en.md", "slug: a\nsection: work\norder: 1");
    chapter("b.en.md", "slug: b\nsection: work\norder: 1");
    expect(() => loadChapters(dir)).toThrow("share order 1 in work");
  });

  test("allows the same order in different sections and sorts by section first", () => {
    chapter("a.en.md", "slug: a\nsection: reference\norder: 1");
    chapter("b.en.md", "slug: b\nsection: start\norder: 2");
    chapter("c.en.md", "slug: c\nsection: start\norder: 1");
    chapter("d.en.md", "slug: d\nsection: operate\norder: 1");
    expect(loadChapters(dir).map((c) => c.slug)).toEqual(["c", "b", "d", "a"]);
  });

  test("reads summary and path_choice from frontmatter", () => {
    chapter(
      "a.en.md",
      "slug: a\nsummary: Learn a.\nsection: start\npath_choice: hosting\norder: 1",
    );
    chapter("b.en.md", "slug: b\nsection: start\npath_choice: hosting\norder: 2");
    const [a] = loadChapters(dir);
    expect(a?.summary).toBe("Learn a.");
    expect(a?.pathChoice).toBe("hosting");
  });

  test("rejects path_choice outside section start", () => {
    chapter("a.en.md", "slug: a\nsection: work\npath_choice: hosting\norder: 1");
    expect(() => loadChapters(dir)).toThrow("path_choice outside section start");
  });

  test("rejects a path_choice group with one chapter", () => {
    chapter("a.en.md", "slug: a\nsection: start\npath_choice: hosting\norder: 1");
    expect(() => loadChapters(dir)).toThrow("path_choice hosting needs at least two chapters");
  });

  test("rejects a path_choice group that is not adjacent", () => {
    chapter("a.en.md", "slug: a\nsection: start\npath_choice: hosting\norder: 1");
    chapter("b.en.md", "slug: b\nsection: start\norder: 2");
    chapter("c.en.md", "slug: c\nsection: start\npath_choice: hosting\norder: 3");
    expect(() => loadChapters(dir)).toThrow("path_choice hosting chapters must be adjacent");
  });

  test("rejects a missing frontmatter", () => {
    writeFileSync(join(dir, "a.en.md"), "## A\n");
    expect(() => loadChapters(dir)).toThrow("no frontmatter");
  });

  test("reads an optional title", () => {
    chapter("a.de.md", "slug: a\ntitle: Was ist SubKit?\nsection: start\norder: 1");
    chapter("b.de.md", "slug: b\nsection: start\norder: 2");
    expect(loadChapters(dir, "de").map((c) => c.title)).toEqual(["Was ist SubKit?", undefined]);
  });
});

describe("summary", () => {
  test("keeps underscores inside inline code", () => {
    expect(summary("Use the `transactional_delivery` profile. More.")).toBe(
      "Use the transactional_delivery profile.",
    );
  });

  test("keeps bare snake_case identifiers", () => {
    expect(summary("Configured with product_id and oauth2_client_credentials.")).toBe(
      "Configured with product_id and oauth2_client_credentials.",
    );
  });

  test("keeps emphasis characters inside inline code", () => {
    expect(summary("Match `a*b*c` and `__init__` here.")).toBe("Match a*b*c and __init__ here.");
  });

  test("strips real emphasis markers", () => {
    expect(summary("Ships **61 templates**, *fast*, _quiet_ and __strong__ text.")).toBe(
      "Ships 61 templates, fast, quiet and strong text.",
    );
  });

  test("keeps code inside link labels", () => {
    expect(summary("See [`product_id`](cli.md#x) docs.")).toBe("See product_id docs.");
  });
});

describe("headingAnchors", () => {
  test("de-duplicates repeated headings deterministically", () => {
    const md = "## Verify\n### 1. Decide\ntext\n## Verify\n### 1. Decide\n## Verify\n";
    expect(headingAnchors(md)).toEqual([
      "verify",
      "1-decide",
      "verify-1",
      "1-decide-1",
      "verify-2",
    ]);
  });

  test("ignores headings inside code fences", () => {
    expect(headingAnchors("```\n# not\n```\n## Real\n")).toEqual(["real"]);
  });
});

describe("repositoryReferences", () => {
  test("keeps shipped links and fails on other markdown links", () => {
    expect(repositoryReferences("[a](cli.md#x)", ["cli.md"])).toBe("[a](cli.md#x)");
    expect(() => repositoryReferences("[a](other.md)", ["cli.md"])).toThrow("not shipped");
  });
});

describe("German chapters", () => {
  const referenceDir = join(import.meta.dir, "../../apps/engine/src/http/reference");
  const generated = ["cli", "settings", "connectors"];
  const english = loadChapters(referenceDir, "en");
  const german = loadChapters(referenceDir, "de");

  test("every authored chapter has a German counterpart in the same section and order", () => {
    for (const en of english) {
      const de = german.find((c) => c.slug === en.slug);
      expect(de, `missing German chapter ${en.slug}`).toBeDefined();
      expect(de?.section, en.slug).toBe(en.section);
      expect(de?.order, en.slug).toBe(en.order);
    }
  });

  test("German chapters pair with an English chapter or a generated page", () => {
    for (const de of german) {
      const known = english.some((c) => c.slug === de.slug) || generated.includes(de.slug);
      expect(known, `unpaired German chapter ${de.slug}`).toBe(true);
    }
    for (const slug of generated) {
      expect(german.some((c) => c.slug === slug)).toBe(true);
    }
  });

  test("heading counts match per pair", () => {
    for (const en of english) {
      const de = german.find((c) => c.slug === en.slug);
      expect(headingCounts(de?.body ?? ""), en.slug).toEqual(headingCounts(en.body));
    }
  });
});

describe("docs bundle", () => {
  const referenceDir = join(import.meta.dir, "../../apps/engine/src/http/reference");
  const raw = readFileSync(
    join(import.meta.dir, "../../apps/engine/src/http/llms/docs.json"),
    "utf8",
  );
  const bundle = DocsBundleSchema.parse(JSON.parse(raw));
  const german = loadChapters(referenceDir, "de");

  test("is serialized stably with a trailing newline and pages in reading order", () => {
    expect(raw).toBe(`${JSON.stringify(bundle, null, 2)}\n`);
    expect(bundle.pages).toEqual([...bundle.pages].sort(byReadingPath));
  });

  test("carries every section once with English and German text", () => {
    expect(bundle.sections.map((s) => s.id)).toEqual([...DOCS_SECTION_IDS]);
    for (const section of bundle.sections) {
      for (const text of [section.locales.en, section.locales.de]) {
        expect(text.title.trim(), section.id).not.toBe("");
        expect(text.description.trim(), section.id).not.toBe("");
      }
    }
  });

  test("every section has chapters numbered from one without gaps", () => {
    for (const id of DOCS_SECTION_IDS) {
      const orders = bundle.pages.filter((p) => p.section === id).map((p) => p.order);
      expect(orders.length, id).toBeGreaterThan(0);
      expect(orders, id).toEqual(orders.map((_, i) => i + 1));
    }
  });

  test("starts the reading path with the intro", () => {
    expect(bundle.pages[0]?.slug).toBe("intro");
    expect(bundle.pages[0]?.section).toBe("start");
  });

  test("hashes each locale body", () => {
    for (const page of bundle.pages) {
      for (const locale of [page.locales.en, page.locales.de]) {
        expect(locale.sha256, page.slug).toBe(
          createHash("sha256").update(locale.body).digest("hex"),
        );
      }
    }
  });

  test("prepends the German intro to the English body of generated pages", () => {
    const generated = bundle.pages.filter((p) => p.generated);
    expect(generated.map((p) => p.slug)).toEqual(["cli", "settings", "connectors"]);
    for (const page of generated) {
      const intro = german.find((c) => c.slug === page.slug)?.body.trimEnd() ?? "";
      expect(page.locales.de.body, page.slug).toBe(`${intro}\n\n${page.locales.en.body}`);
    }
  });

  test("titles generated pages in German from their German intro", () => {
    for (const page of bundle.pages.filter((p) => p.generated)) {
      const title = german.find((c) => c.slug === page.slug)?.title;
      expect(title, page.slug).toBeTruthy();
      expect(page.locales.de.title, page.slug).toBe(title ?? "");
      expect(page.locales.de.title, page.slug).not.toBe(page.locales.en.title);
    }
  });

  test("titles the intro from its frontmatter in both locales", () => {
    const intro = bundle.pages.find((p) => p.slug === "intro");
    expect(intro?.locales.en.title).toBe("What is SubKit?");
    expect(intro?.locales.de.title).toBe("Was ist SubKit?");
  });

  test("carries the German chapter body for authored pages", () => {
    for (const page of bundle.pages.filter((p) => !p.generated)) {
      const de = german.find((c) => c.slug === page.slug);
      expect(page.locales.de.body, page.slug).toBe(de?.body.trimEnd());
    }
  });

  test("maps each page to the most specific llms page that contains it", () => {
    const own: Record<string, string> = {
      "use-sk-from-a-coding-agent": "coding-agents.md",
      "transactional-email-replies": "transactional-email.md",
      cli: "cli.md",
      settings: "settings.md",
      connectors: "connectors.md",
    };
    for (const page of bundle.pages) {
      expect(page.llms_path, page.slug).toBe(own[page.slug] ?? "setup.md");
    }
    const paths = new Set(bundle.pages.map((p) => p.llms_path));
    expect([...paths].sort()).toEqual([...LLMS_PAGE_PATHS].sort());
    expect(bundle.pages.find((p) => p.llms_path === "setup.md")?.slug).toBe("intro");
  });

  test("carries the seed version of the coding-agent chapter into its seed", () => {
    const chapter = loadChapters(referenceDir).find((c) => c.seed === "sk-ref-coding-agents");
    expect(chapter?.seedVersion).toBeGreaterThanOrEqual(2);
    const seed = readFileSync(
      join(import.meta.dir, "../../apps/engine/src/conversations/seed/knowledge/coding-agents.md"),
      "utf8",
    );
    expect(seed).toMatch(new RegExp(`^---\\n[\\s\\S]*^version: ${chapter?.seedVersion}$`, "m"));
  });
});
