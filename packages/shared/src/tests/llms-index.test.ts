import { describe, expect, test } from "bun:test";
import { LLMS_PAGE_PATHS, type LlmsPage, renderLlmsIndex } from "../llms-index.ts";

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
