import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const viteConfig = readFileSync(join(root, "apps/cockpit/vite.config.ts"), "utf8");
const sourceHtml = readFileSync(join(root, "apps/cockpit/index.html"), "utf8");
const faviconSvg = readFileSync(join(root, "apps/cockpit/public/favicon.svg"), "utf8");

const base = viteConfig.match(/\bbase:\s*"([^"]+)"/)?.[1];

function faviconHref(html: string): string | null {
  const link = html.match(/<link\b[^>]*\brel="[^"]*\bicon\b[^"]*"[^>]*>/i)?.[0];
  return link?.match(/\bhref="([^"]+)"/i)?.[1] ?? null;
}

describe("the favicon link carries the base path exactly once", () => {
  test("the vite config declares a base path", () => {
    expect(base).toBeString();
    expect(base?.startsWith("/")).toBe(true);
    expect(base?.endsWith("/")).toBe(true);
  });

  test("the source references an icon at all", () => {
    expect(faviconHref(sourceHtml)).toBeString();
  });

  test("the source does NOT spell out the base path itself", () => {
    const href = faviconHref(sourceHtml) ?? "";
    expect(
      href.startsWith(base ?? "/"),
      `apps/cockpit/index.html carries href="${href}" — Vite prepends "${base}" at build time, so this would be doubled`,
    ).toBe(false);
    expect(
      href.startsWith("/"),
      `href="${href}" is document-relative and points somewhere else on every subpage`,
    ).toBe(true);
  });

  test("the icon is a public asset, so Vite prefixes it with base exactly once", () => {
    const source = faviconHref(sourceHtml) ?? "";
    expect(existsSync(join(root, "apps/cockpit/public", source.slice(1)))).toBe(true);
  });

  test("the file itself is well-formed XML", () => {
    const comments = [...faviconSvg.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1] ?? "");
    for (const comment of comments) expect(comment).not.toContain("--");
    expect(faviconSvg.trimStart().startsWith("<svg")).toBe(true);
    expect(faviconSvg).toContain("prefers-color-scheme: dark");
  });
});
