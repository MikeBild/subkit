// Unit tests for the shared llms.txt index renderer — the single format
// source consumed by both the build script (repo-relative links) and the
// engine route (origin links). These pin the spec invariants: a `>` lede with
// the full-text pointer, audience sections, the `## Optional` carve-out per
// the llmstxt.org spec, and that `linkFor` actually drives the hrefs.

import { describe, expect, test } from "bun:test";
import { type LlmsPage, OPTIONAL_PATHS, renderLlmsIndex } from "../llms-index.ts";

function page(over: Partial<LlmsPage> & Pick<LlmsPage, "audience" | "path" | "title">): LlmsPage {
  return { summary: "", ...over };
}

const pages: LlmsPage[] = [
  page({
    audience: "concepts",
    path: "docs/concepts/README.md",
    title: "Concepts",
    summary: "Overview.",
  }),
  page({
    audience: "concepts",
    path: "docs/concepts/connectors.md",
    title: "Connectors",
    summary: "What a connector is.",
  }),
  page({
    audience: "developers",
    path: "docs/developers/tool-palette.md",
    title: "API",
    summary: "",
  }),
  // Two optional (auto-generated reference) pages.
  page({
    audience: "developers",
    path: "docs/developers/cli-reference.md",
    title: "CLI Reference",
    summary: "Every command.",
  }),
  page({
    audience: "authors",
    path: "docs/authors/slash-commands.md",
    title: "Slash Commands",
    summary: "Commands.",
  }),
];

describe("renderLlmsIndex", () => {
  const out = renderLlmsIndex(pages, {
    linkFor: (p) => `https://x/llms/${p.path.replace(/^docs\//, "")}`,
    fullUrl: "https://x/llms-full.txt",
  });

  test("starts with the H1 and a `>` blockquote lede", () => {
    expect(out.startsWith("# sk Documentation\n")).toBe(true);
    expect(out).toContain("\n> ");
  });

  test("lede carries the full-text pointer with the passed fullUrl", () => {
    expect(out).toContain("Full documentation in one file: https://x/llms-full.txt");
  });

  test("applies linkFor to entry hrefs", () => {
    expect(out).toContain(
      "- [Connectors](https://x/llms/concepts/connectors.md): What a connector is.",
    );
    // README sorts first within its audience.
    const concepts = out.indexOf("## Concepts");
    const readmeIdx = out.indexOf("[Concepts](");
    const connIdx = out.indexOf("[Connectors](");
    expect(concepts).toBeLessThan(readmeIdx);
    expect(readmeIdx).toBeLessThan(connIdx);
  });

  test("omits `: summary` when summary is empty", () => {
    expect(out).toContain("- [API](https://x/llms/developers/tool-palette.md)\n");
    expect(out).not.toContain("[API](https://x/llms/developers/tool-palette.md):");
  });

  test("optional pages land under ## Optional and are excluded from audience sections", () => {
    const optionalIdx = out.indexOf("## Optional");
    expect(optionalIdx).toBeGreaterThan(-1);
    // Both OPTIONAL_PATHS present in the input appear, after the heading.
    for (const p of pages.filter((x) => OPTIONAL_PATHS.has(x.path))) {
      const entry = out.indexOf(`(https://x/llms/${p.path.replace(/^docs\//, "")})`);
      expect(entry).toBeGreaterThan(optionalIdx);
    }
    // cli-reference must NOT appear inside the Developers section (before Optional).
    const developers = out.indexOf("## Developers");
    const cliInDevelopers = out.slice(developers, optionalIdx).includes("cli-reference.md");
    expect(cliInDevelopers).toBe(false);
    // slash-commands has no non-optional Authors page, so there is no
    // `## Authors` section at all.
    expect(out).not.toContain("## Authors");
  });

  test("the `start` audience renders first, ahead of every other section", () => {
    const withStart = renderLlmsIndex(
      [
        ...pages,
        page({
          audience: "start",
          path: "docs/start-here.md",
          title: "Start here",
          summary: "What sk is, with no prior knowledge assumed.",
        }),
      ],
      { linkFor: (p) => p.path, fullUrl: "f" },
    );
    const start = withStart.indexOf("## Start here");
    expect(start).toBeGreaterThan(-1);
    expect(withStart).toContain(
      "- [Start here](docs/start-here.md): What sk is, with no prior knowledge assumed.",
    );
    // Ahead of every other audience section that rendered.
    for (const heading of ["## Concepts", "## Developers", "## Optional"]) {
      const idx = withStart.indexOf(heading);
      if (idx > -1) expect(start).toBeLessThan(idx);
    }
  });

  test("no `## Optional` section when no page is optional", () => {
    const nonOptional = pages.filter((p) => !OPTIONAL_PATHS.has(p.path));
    const noneOptional = renderLlmsIndex(nonOptional, {
      linkFor: (p) => p.path,
      fullUrl: "llms-full.txt",
    });
    expect(noneOptional).not.toContain("## Optional");
  });

  test("custom optional predicate overrides the default", () => {
    const out2 = renderLlmsIndex(pages, {
      linkFor: (p) => p.path,
      fullUrl: "f",
      optional: () => false,
    });
    expect(out2).not.toContain("## Optional");
    // cli-reference now appears in its audience section.
    expect(out2).toContain("[CLI Reference](docs/developers/cli-reference.md)");
  });
});
