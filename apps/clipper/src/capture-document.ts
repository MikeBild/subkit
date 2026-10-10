export function prepareCaptureDocument(root: Document): {
  document: Document;
  metadataSkipped: boolean;
} {
  const document = root.cloneNode(true) as Document;
  let metadataSkipped = false;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const source = (script.textContent || "")
        .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
        .trim();
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== "object") throw new Error("Invalid metadata object");
      script.textContent = JSON.stringify(value).replaceAll("/", "\\u002f");
    } catch {
      script.remove();
      metadataSkipped = true;
    }
  }
  return { document, metadataSkipped };
}

export function fallbackArticleText(root: Document): string {
  const document = root.cloneNode(true) as Document;
  for (const element of document.querySelectorAll(
    'script, style, noscript, template, nav, aside, footer, form, button, input, textarea, select, iframe, object, embed, svg, [hidden], [aria-hidden="true"], [role="navigation"], [role="dialog"], [role="banner"], [role="contentinfo"], [style*="display: none"], [style*="display:none"]',
  )) {
    element.remove();
  }
  const candidates = [...document.querySelectorAll('article, main, [role="main"]')];
  const content =
    candidates.sort(
      (left, right) => (right.textContent?.length || 0) - (left.textContent?.length || 0),
    )[0] || document.body;
  if (!content) return "";
  for (const element of content.querySelectorAll(
    "br, p, div, section, h1, h2, h3, h4, li, tr, pre, blockquote",
  )) {
    element.before(document.createTextNode("\n"));
    element.after(document.createTextNode("\n"));
  }
  return (content.textContent || "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}
