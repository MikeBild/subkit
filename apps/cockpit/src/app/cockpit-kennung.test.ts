import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const sourceHtml = readFileSync(join(root, "apps/cockpit/index.html"), "utf8");
const viteConfig = readFileSync(join(root, "apps/cockpit/vite.config.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };

const MARKER = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/;

function kennung(html: string): string | null {
  return MARKER.exec(html)?.[1] ?? null;
}

describe("the console says which product it is", () => {
  test("the source carries exactly one definition site", () => {
    expect(kennung(sourceHtml)).toBeString();
    expect(
      [...sourceHtml.matchAll(/name="cockpit-product"/g)],
      "two markers are two answers to the same question",
    ).toHaveLength(1);
  });

  test("the build leaves the marker as the source defines it", () => {
    expect(viteConfig).not.toContain("cockpit-product");
    expect(viteConfig).toMatch(/\broot,\s/);
  });

  test("the identifier IS the product name from package.json", () => {
    expect(kennung(sourceHtml)?.toLowerCase()).toBe(pkg.name.toLowerCase());
  });

  test("the identifier is NOT the title and not the wordmark", () => {
    const titel = /<title>([^<]*)<\/title>/.exec(sourceHtml)?.[1]?.trim();
    expect(titel).toBeString();
    expect(titel).not.toBe(kennung(sourceHtml));
  });
});
