import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { prepareCaptureDocument } from "./capture-document.ts";
import { captureDiagnosticMessages, copy } from "./ui.ts";

test("valid metadata preserves comment-like strings and independent valid blocks", () => {
  const value = {
    "@type": "Article",
    headline: "A /* literal */ title",
    url: "https://example.test/path",
  };
  const dom = new JSDOM(
    `<script type="application/ld+json">${JSON.stringify(value)}</script><script type="application/ld+json">broken</script>`,
  );
  try {
    const prepared = prepareCaptureDocument(dom.window.document);
    const scripts = prepared.document.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(1);
    expect(JSON.parse(scripts[0]?.textContent || "")).toEqual(value);
    expect(scripts[0]?.textContent).not.toContain("/*");
    expect(prepared.metadataSkipped).toBe(true);
    expect(dom.window.document.querySelectorAll("script")).toHaveLength(2);
  } finally {
    dom.window.close();
  }
});

test("capture notices are localized and repeated metadata failures produce one notice", () => {
  for (const text of [copy.de, copy.en]) {
    expect(
      captureDiagnosticMessages(
        [
          { code: "metadata_unavailable" },
          { code: "metadata_unavailable" },
          { code: "article_fallback" },
        ],
        text,
      ),
    ).toEqual([text.metadataUnavailable, text.articleFallback]);
    expect(captureDiagnosticMessages(undefined, text)).toEqual([]);
    expect(captureDiagnosticMessages([{ code: "selection_unavailable" }], text)).toEqual([
      text.selectionEmpty,
    ]);
  }
});
