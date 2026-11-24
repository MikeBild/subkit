import { describe, expect, it } from "bun:test";
import { markdownLink } from "@ui/lib/markdown";
import { UiProvider } from "@ui/lib/ui-context";
import { MarkdownDocument } from "@ui/organisms/markdown-document";
import { renderToStaticMarkup } from "react-dom/server";

const html = (text: string) =>
  renderToStaticMarkup(
    <UiProvider lang="en">
      <MarkdownDocument text={text} toolbar={false} toc={false} />
    </UiProvider>,
  );

const anchor = (out: string) => /<a [^>]*>/.exec(out)?.[0] ?? "";

describe("markdown document links (#598)", () => {
  it("opens an absolute source link in a new tab with the exact href", () => {
    const tag = anchor(html("[Open](https://example.test/doc?token=***&page=2)"));
    expect(tag).toContain('href="https://example.test/doc?token=***&amp;page=2"');
    expect(tag).toContain('target="_blank"');
    expect(tag).toContain('rel="noopener noreferrer"');
  });

  it("opens mailto links in a new tab as well", () => {
    const tag = anchor(html("[Mail](mailto:ops@example.test)"));
    expect(tag).toContain('href="mailto:ops@example.test"');
    expect(tag).toContain('rel="noopener noreferrer"');
  });

  it("keeps relative and javascript links out of a new tab", () => {
    for (const src of ["[Rel](/settings)", "[Js](javascript:alert(1))"])
      expect(anchor(html(src))).not.toContain("target=");
  });
});

describe("markdownLink", () => {
  it("classifies http, https and mailto as external", () => {
    for (const href of ["https://example.test/a", "HTTP://example.test", "mailto:a@example.test"])
      expect(markdownLink(href)).toEqual({ kind: "external", href });
  });

  it("turns a fragment into a heading id", () => {
    expect(markdownLink("#next-steps")).toEqual({ kind: "fragment", id: "next-steps" });
    expect(markdownLink("#caf%C3%A9")).toEqual({ kind: "fragment", id: "café" });
  });

  it("keeps every other href inert", () => {
    for (const href of [
      undefined,
      "",
      "#",
      "#%E0%A4%A",
      "/settings",
      "doc.md",
      "javascript:alert(1)",
      "data:text/html,x",
      "//evil.test",
    ])
      expect(markdownLink(href)).toEqual({ kind: "inert" });
  });
});
