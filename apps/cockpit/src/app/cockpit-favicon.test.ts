// Pins the favicon path across source and build.
//
// Vite prepends `base` at build time, so the SOURCE href must not carry it:
// "/cockpit/favicon.svg" in source builds to "/cockpit/cockpit/favicon.svg",
// which registerCockpitRoutes answers with the SPA fallback — 200, text/html,
// a tab without an icon, and a status-code-only assert nods it through.
// "./favicon.svg" resolves against the current address and points somewhere
// else on every subpage. One rule catches both: the source does not start with
// the base path, and the built href is exactly base + source.
//
// Pattern copied (not imported) from WikiKit 3b72135 — the convention is a
// document, not a package (§7). The built copy is committed under assets/cockpit
// and held against the source by `bun run check:cockpit-drift`, so it is a
// stable measuring point and not a snapshot of somebody's machine.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const viteConfig = readFileSync(join(root, "apps/cockpit/vite.config.ts"), "utf8");
const sourceHtml = readFileSync(join(root, "apps/cockpit/index.html"), "utf8");
const builtHtml = readFileSync(join(root, "assets/cockpit/index.html"), "utf8");
const faviconSvg = readFileSync(join(root, "apps/cockpit/public/favicon.svg"), "utf8");

/** The base path, read from the vite config instead of repeated here. */
const base = viteConfig.match(/\bbase:\s*"([^"]+)"/)?.[1];

/** The href of the favicon link, or null if there is none. */
function faviconHref(html: string): string | null {
  const link = html.match(/<link\b[^>]*\brel="[^"]*\bicon\b[^"]*"[^>]*>/i)?.[0];
  return link?.match(/\bhref="([^"]+)"/i)?.[1] ?? null;
}

describe("the favicon link carries the base path exactly once", () => {
  test("the vite config declares a base path", () => {
    // Guards the two regexes above: a config that no longer matches would make
    // the tests below silently true.
    expect(base).toBeString();
    expect(base?.startsWith("/")).toBe(true);
    expect(base?.endsWith("/")).toBe(true);
  });

  test("source and build reference an icon at all", () => {
    expect(faviconHref(sourceHtml)).toBeString();
    expect(faviconHref(builtHtml)).toBeString();
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

  test("the build is exactly base + source", () => {
    const source = faviconHref(sourceHtml) ?? "";
    const built = faviconHref(builtHtml) ?? "";
    expect(built).toBe(`${base}${source.slice(1)}`);
  });

  test("the file itself is well-formed XML", () => {
    // Two consecutive hyphens end an XML comment early. The server still
    // answers 200 with image/svg+xml and the file renders nothing — the
    // quietest possible failure in the most visible place.
    const comments = [...faviconSvg.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => match[1] ?? "");
    for (const comment of comments) expect(comment).not.toContain("--");
    expect(faviconSvg.trimStart().startsWith("<svg")).toBe(true);
    expect(faviconSvg).toContain("prefers-color-scheme: dark");
  });
});
