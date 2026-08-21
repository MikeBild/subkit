// Pins the product identifier in the SHIPPED document.
//
// scripts/konvention-check.mjs checks the marker on the served document and thus
// answers "whose console replied?". This file checks it on the BUILT copy, since
// only that one ships: a marker the build drops, renames or duplicates turns every
// run against your own console into "foreign document" — the most expensive wrong
// answer there is. Same reasoning as the favicon (cockpit-favicon.test.ts): source
// and build are two truths until something holds them against each other.
//
// The value is held against `package.json` instead of repeated here: the marker
// exists to say WHICH product this is, so one that can drift from the product name
// would be worse than none.
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

/** A document's identifier, or null if it carries none. */
function kennung(html: string): string | null {
  return MARKER.exec(html)?.[1] ?? null;
}

describe("the built console says which product it is", () => {
  test("the source carries exactly one definition site", () => {
    expect(kennung(sourceHtml)).toBeString();
    expect([...sourceHtml.matchAll(/name="cockpit-product"/g)]).toHaveLength(1);
  });

  test("the build carries it unchanged and exactly once", () => {
    // Vite rewrites `href` and `src`, not `content` — this test turns that
    // expectation into a guarantee.
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
    // `bun build --compile` serves the cockpit from cockpit-embedded.ts, not from
    // assets/cockpit. An identifier that only exists on disk fails to answer
    // exactly where an operator asks.
    const embedded = Buffer.from(EMBEDDED_COCKPIT["index.html"] ?? "", "base64").toString("utf8");
    expect(kennung(embedded)).toBe(kennung(sourceHtml));
  });

  test("the identifier is NOT the title and not the wordmark", () => {
    // §6 checks browser title and wordmark; an identifier that is itself under
    // test turns every real violation into "that isn't SubKit". The title may
    // contain the identifier, but it must not BE it.
    const titel = /<title>([^<]*)<\/title>/.exec(builtHtml)?.[1]?.trim();
    expect(titel).toBeString();
    expect(titel).not.toBe(kennung(builtHtml));
  });
});
