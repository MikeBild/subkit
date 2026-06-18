// Convert raw HTML page-text into Markdown for LLM consumption.
//
// Both `html-scrape` and `playwright-crawl` accumulate `text_corpus`
// by concatenating raw HTML fragments. The LLM then has to read past
// `<div class="…">` noise to find the actual prose. Our observability
// heuristics consistently show 30-50% token savings + better answer
// quality when the corpus is Markdown.
//
// `node-html-markdown` — ~50KB, no DOM dependency, fast (parse + emit in
// a single pass).

import { NodeHtmlMarkdown } from "node-html-markdown";

const converter = new NodeHtmlMarkdown(
  {
    keepDataImages: false,
    useInlineLinks: true,
    bulletMarker: "-",
  },
  // No custom translators — defaults handle headings, lists, code,
  // tables, links, emphasis. Skip iframes/style/script (the converter
  // strips them by default but be explicit for tables-of-contents
  // pages).
  {
    iframe: { ignore: true },
    style: { ignore: true },
    script: { ignore: true },
    noscript: { ignore: true },
  },
);

/** True when the input has signs of being HTML (vs. markdown / plain
 *  text / JSON). Used as a guard so we don't double-convert markdown
 *  that already came out of an llms.txt source. */
export function looksLikeHtml(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 2048).toLowerCase();
  return (
    head.includes("<!doctype") ||
    head.includes("<html") ||
    head.includes("<body") ||
    // Inline tag heuristic: `<tag>` or `<tag …>` or `<tag/>`. Matches
    // both attribute-bearing tags (`<div class="x">`) and bare tags
    // (`<p>`, `<h1>`).
    /<[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/.test(head)
  );
}

/** Convert HTML to Markdown. Returns the input unchanged when it
 *  doesn't look like HTML, so the helper is safe to apply
 *  unconditionally on any `text_corpus` candidate. */
export function htmlToMarkdown(text: string): string {
  if (!text) return text;
  if (!looksLikeHtml(text)) return text;
  try {
    return converter.translate(text).trim();
  } catch {
    // Conversion failure is non-fatal — fall back to the raw HTML so
    // the LLM still gets the prose, just with markup noise.
    return text;
  }
}
