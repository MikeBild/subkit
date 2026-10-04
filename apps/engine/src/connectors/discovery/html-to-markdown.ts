import { NodeHtmlMarkdown } from "node-html-markdown";

const converter = new NodeHtmlMarkdown(
  {
    keepDataImages: false,
    useInlineLinks: true,
    bulletMarker: "-",
  },
  {
    iframe: { ignore: true },
    style: { ignore: true },
    script: { ignore: true },
    noscript: { ignore: true },
  },
);

export function looksLikeHtml(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 2048).toLowerCase();
  return (
    head.includes("<!doctype") ||
    head.includes("<html") ||
    head.includes("<body") ||
    /<[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/.test(head)
  );
}

export function htmlToMarkdown(text: string): string {
  if (!text) return text;
  if (!looksLikeHtml(text)) return text;
  try {
    return converter.translate(text).trim();
  } catch {
    return text;
  }
}
