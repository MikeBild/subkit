import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { chromeApi } from "./chrome-api.ts";
import type { CapturedClip } from "./types.ts";

function meta(names: string[]): string | undefined {
  for (const name of names) {
    const element = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    const value = element?.getAttribute("content")?.trim();
    if (value) return value;
  }
  return undefined;
}

function absoluteUrls(root: Element): void {
  for (const element of root.querySelectorAll<HTMLElement>("[href], [src]")) {
    for (const attribute of ["href", "src"] as const) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      try {
        element.setAttribute(attribute, new URL(value, location.href).toString());
      } catch {}
    }
  }
}

function toMarkdown(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script, style, noscript, template").forEach((element) => {
    element.remove();
  });
  absoluteUrls(parsed.body);
  return new TurndownService({ headingStyle: "atx", bulletListMarker: "-" }).turndown(parsed.body);
}

function selectionHtml(): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return undefined;
  const holder = document.createElement("div");
  for (let index = 0; index < selection.rangeCount; index += 1) {
    holder.append(selection.getRangeAt(index).cloneContents());
  }
  return holder.innerHTML;
}

function extractArticle(): {
  title: string;
  content: string;
  byline?: string;
  publishedAt?: string;
} {
  const parsed = new Readability(document.cloneNode(true) as Document).parse();
  const publishedAt = meta(["article:published_time", "date", "publishdate", "datePublished"]);
  return {
    title: parsed?.title?.trim() || document.title.trim() || location.hostname,
    content: parsed?.content || document.body.innerHTML,
    ...(parsed?.byline ? { byline: parsed.byline } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

export function capture(mode: "article" | "selection"): CapturedClip {
  const selected = mode === "selection" ? selectionHtml() : undefined;
  const article = extractArticle();
  const author = article.byline || meta(["author", "article:author"]);
  return {
    metadata: {
      title: article.title,
      sourceUrl: location.href,
      capturedAt: new Date().toISOString(),
      ...(author ? { author } : {}),
      ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
    },
    body: toMarkdown(selected || article.content),
  };
}

const pageState = globalThis as typeof globalThis & { subkitCaptureHandler?: boolean };

if (!pageState.subkitCaptureHandler) {
  pageState.subkitCaptureHandler = true;
  chromeApi.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") return undefined;
    const request = message as { type?: string; mode?: "article" | "selection" };
    if (request.type !== "capture") return undefined;
    return Promise.resolve(capture(request.mode === "selection" ? "selection" : "article"));
  });
}
