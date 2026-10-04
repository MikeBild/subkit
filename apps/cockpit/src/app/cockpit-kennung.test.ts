import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_COCKPIT } from "../../../engine/src/http/cockpit-embedded.ts";

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const sourceHtml = readFileSync(join(root, "apps/cockpit/index.html"), "utf8");
const builtHtml = readFileSync(join(root, "assets/cockpit/index.html"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };

const MARKER = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/;

function kennung(html: string): string | null {
  return MARKER.exec(html)?.[1] ?? null;
}

describe("the built console says which product it is", () => {
  test("the source carries exactly one definition site", () => {
    expect(kennung(sourceHtml)).toBeString();
    expect([...sourceHtml.matchAll(/name="cockpit-product"/g)]).toHaveLength(1);
  });

  test("the build carries it unchanged and exactly once", () => {
    expect(kennung(builtHtml)).toBe(kennung(sourceHtml));
    expect(
      [...builtHtml.matchAll(/name="cockpit-product"/g)],
      "two markers are two answers to the same question",
    ).toHaveLength(1);
  });

  test("the identifier IS the product name from package.json", () => {
    expect(kennung(builtHtml)?.toLowerCase()).toBe(pkg.name.toLowerCase());
  });

  test("the embedded copy carries it too", () => {
    const embedded = Buffer.from(EMBEDDED_COCKPIT["index.html"] ?? "", "base64").toString("utf8");
    expect(kennung(embedded)).toBe(kennung(sourceHtml));
  });

  test("the identifier is NOT the title and not the wordmark", () => {
    const titel = /<title>([^<]*)<\/title>/.exec(builtHtml)?.[1]?.trim();
    expect(titel).toBeString();
    expect(titel).not.toBe(kennung(builtHtml));
  });
});
