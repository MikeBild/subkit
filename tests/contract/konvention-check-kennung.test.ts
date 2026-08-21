// The convention check's identity assert, held by machine.
//
// `startPreview` answers "is something there?", not "is SubKit there?". At
// CodeKit that gap produced 8 breaches in 156 s against a surface that was
// WorkKit — no timeout, no crash, a complete and convincing false report. §7
// makes it likely: the DOM anchors are identical across all six consoles, so a
// sister console meets every precondition, and the stands sit next to each
// other (4081 · 4173 · 4176 · 4183 · 4192).
//
// What this file pins is the better shape: exactly one definition site,
// `apps/cockpit/index.html`, which the script READS. Copied from WatchKit, not
// imported — the convention is a document, not a package (§7).
//
// It lives in tests/contract/ because CI's shard job runs `apps packages` only
// (LOCAL-SK-SCRIPTS-TESTS-NICHT-IN-CI); a guard over a mandatory gate stage that
// CI never runs is just another comment. `bun run test:contract` runs this.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = readFileSync(join(root, "scripts/konvention-check.mjs"), "utf8");

/**
 * Comments out, string literals intact.
 *
 * Both halves are load-bearing. Stripping only comments that OWN their line —
 * which is what a `/^\s*(\/\/|\*)/` regex does — leaves a TRAILING comment's
 * text in `code`, so an explanation mentioning the product name failed the ban
 * below instead of the abbreviation it is meant to catch. Cutting blindly at
 * "//" is the opposite trap: this script carries `http://` inside string
 * literals, and a blind cut takes the rest of those lines with it, which can
 * silently swallow the very occurrence the ban is looking for.
 *
 * Newlines survive so line numbers still line up with the file. A quote left
 * open at end of line is force-closed: a regex literal such as
 * /content="([^"]+)"/ leaves an odd number of quotes behind, and JS string
 * literals cannot span lines anyway, so any confusion stays on its own line.
 */
function stripComments(input: string): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    const next = input[i + 1];
    if (quote !== null) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const code = stripComments(source);

const shell = readFileSync(join(root, "apps/cockpit/index.html"), "utf8");
const marker = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(shell)?.[1];

/** The assert's body — not the whole file, see the ban below. */
function assertBody(): string {
  const start = code.indexOf("function assertPruefstandsKennung(html) {");
  expect(start, "the identity assert is findable").toBeGreaterThan(0);
  return code.slice(start, code.indexOf("\n}\n", start));
}

describe("the convention check asks whose console answered", () => {
  test("apps/cockpit/index.html is the definition site", () => {
    // Without a marker in the source every ban below would be silently true.
    expect(marker, 'apps/cockpit/index.html carries <meta name="cockpit-product">').toBeTruthy();
    expect([...shell.matchAll(/name="cockpit-product"/g)]).toHaveLength(1);
  });

  test("the assert derives its expected value instead of typing it", () => {
    expect(code).toContain(
      'const quelle = new URL("../apps/cockpit/index.html", import.meta.url);',
    );
    expect(code).toContain("const erwartet = markerIn(readFileSync(quelle,");

    const body = assertBody();
    expect(
      body.includes(`'${marker}'`) || body.includes(`"${marker}"`),
      `the body types "${marker}" instead of reading it from apps/cockpit/index.html`,
    ).toBe(false);
    // And not via the existing constant either: `PRODUCT_NAME` is what §6
    // measures. An identity that is also a checked rule turns every real breach
    // into "that is not SubKit".
    expect(body).not.toContain("PRODUCT_NAME");
    expect(body).not.toContain("<title>SubKit");
  });

  test("the expected value occurs exactly once in the code, as PRODUCT_NAME", () => {
    // Checking the body alone was bypassable: `const RUECKFALL = "SubKit"` at
    // module level plus `erwartet || RUECKFALL` inside kept all seven statements
    // green with a hand-typed target restored. One occurrence, and it is the
    // constant §6 measures the wordmark against; a second one is the fallback.
    const literal = new RegExp(marker?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "", "g");
    const treffer = [...code.matchAll(literal)];
    expect(
      treffer,
      `"${marker}" occurs ${treffer.length}x in the code, exactly 1x is allowed`,
    ).toHaveLength(1);
    expect(code).toContain(`const PRODUCT_NAME = "${marker}";`);
  });

  test("the comment filter takes trailing comments and leaves strings alone", () => {
    // The reverse false alarm: without it a trailing comment naming the product
    // turns the statement above into a groundless failure.
    expect(stripComments(`const a = 1; // ${marker} explains something here`)).toBe(
      "const a = 1; ",
    );
    expect(stripComments('const u = "http://127.0.0.1:4176/cockpit/";')).toBe(
      'const u = "http://127.0.0.1:4176/cockpit/";',
    );
    // And it must not eat the file: the line count survives.
    expect(code.split("\n")).toHaveLength(source.split("\n").length);
  });

  test("a renamed attribute is a finding about THIS repository", () => {
    // CodeKit's version says it the wrong way round: there a renamed marker
    // reports "foreign document" about its own console.
    // The expectation IS the script's source text; a template literal would
    // resolve it instead of checking it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    expect(code).toContain('no longer carries <meta name="${IDENTITY_META}" content="…">.');
    expect(code).toContain("a finding about THIS repository");
  });

  test("a foreign console is NAMED, not merely rejected", () => {
    expect(code).toContain("Its title reads");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    expect(code).toContain("this is not ${erwartet} but ${geliefert}");
  });

  test("the identity is checked BEFORE the browser starts", () => {
    // Otherwise a foreign peer costs a whole run before being discarded: 156 s.
    const kennung = code.indexOf("assertPruefstandsKennung(preview.shell);");
    const browser = code.indexOf("await chromium.launch(");
    expect(kennung, "the assert is called").toBeGreaterThan(0);
    expect(browser, "the browser is launched").toBeGreaterThan(0);
    expect(kennung).toBeLessThan(browser);
  });

  test("the document that was waited on is the one checked, not a second one", () => {
    // Two fetches are two documents, and the identity would vouch for one the
    // run never measured.
    expect(code).toContain("if (response.ok) return { server, shell: await response.text() };");
    expect(code).toContain("assertPruefstandsKennung(preview.shell);");
  });

  test('"not measured" has an exit code of its own', () => {
    // 1 is a work list, 2 is an absent measurement — for a mandatory gate stage
    // the difference between repairing and muting.
    expect(code).toContain("class NichtGemessen extends Error {}");
    expect(code).toContain("process.exit(nichtGemessen ? 2 : 1);");
    // And it does not end at the first route: an abort mid-sweep — route 11 of
    // 27 when the preview server dies — never got through the route list and is
    // no more a measurement than a foreign peer before the first one.
    expect(code).toContain(
      "const nichtGemessen = abbruch instanceof NichtGemessen || (Boolean(abbruch) && !routenDurchlaufen);",
    );
    expect(code).toContain("routenDurchlaufen = true;");
    // All three branches of the assert take that exit.
    expect([...assertBody().matchAll(/throw new NichtGemessen\(/g)]).toHaveLength(3);
  });
});
