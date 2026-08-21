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
// `apps/cockpit/index.html`, which the script READS. The rule itself is copied
// from WatchKit rather than imported — the convention is a document, not a
// package (§7). Within THIS repository the opposite holds: the reader used to
// exist twice, here and in scripts/lib/cockpit-identity.mjs, and both copies
// carried the same defect — each answered with the first `content="…"` in the
// document, prose included, so a WorkKit console that quoted our name in a
// comment was measured under the heading "identity SubKit".
//
// The last statements below are the only ones that guard anything: they RUN the
// script against served trap documents, including a stand that CHANGES HANDS
// mid-run. Everything above them reads source text, and source text is not
// effect — `.not.toContain("function markerIn(")` was meant to stop the reader
// growing back, and `const markerIn2 = (html) => …` walked past it 12/12 green.
// Those statements are LOCKS against silent removal, and they are labelled as
// locks; they catch a deletion, never a rewrite.
//
// What the script now promises is not "the identity is asked first" — it was,
// and a stand that changed hands after answering was measured anyway. It is
// that there is no way to a page at all except through `stand.visit()`, which
// navigates and names in one act. The ban on `.goto(` below is the text side of
// that; the runs at the bottom are the effect side.
//
// It lives in tests/contract/ because CI's shard job runs `apps packages` only
// (LOCAL-SK-SCRIPTS-TESTS-NICHT-IN-CI); a guard over a mandatory gate stage that
// CI never runs is just another comment. `bun run test:contract` runs this.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = readFileSync(join(root, "scripts/konvention-check.mjs"), "utf8");
/** The shared door. The refusal sentences moved here when both scripts started using it. */
const library = readFileSync(join(root, "scripts/lib/cockpit-identity.mjs"), "utf8");

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

describe("the convention check asks whose console answered", () => {
  test("apps/cockpit/index.html is the definition site", () => {
    // Without a marker in the source every ban below would be silently true.
    expect(marker, 'apps/cockpit/index.html carries <meta name="cockpit-product">').toBeTruthy();
    expect([...shell.matchAll(/name="cockpit-product"/g)]).toHaveLength(1);
  });

  test("the expected value is derived from the definition site, not typed", () => {
    // The derivation moved into the shared door with the assert. What must not
    // come back is a second definition site in this file.
    expect(library).toContain(
      'export const IDENTITY_SOURCE = new URL("../../apps/cockpit/index.html", import.meta.url);',
    );
    expect(library).toContain("const expected = expectedIdentity();");
    expect(code, "no second definition site here").not.toContain('apps/cockpit/index.html"');
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
    expect(library).toContain('<meta name="${IDENTITY_META}" content="…">.');
    expect(library).toContain("a finding about THIS repository");
  });

  test("a foreign console is NAMED, not merely rejected", () => {
    expect(library).toContain("Its title reads");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    expect(library).toContain("this is not ${expected} but ${delivered}");
  });

  test("the reader is imported, not defined here (a lock, not a guard)", () => {
    // Two copies of one decision are where two versions of it come from: the
    // prose-blind reader was fixed in the library and stood on unfixed here.
    //
    // Deliberately understated. The bans below catch the import DISAPPEARING;
    // they do not catch a reader growing back — `const markerIn2 = (html) => …`
    // kept this file 12/12 green with a second reader in place. What actually
    // holds the class is the runs at the bottom of this file.
    expect(code).toContain('from "./lib/cockpit-identity.mjs"');
    expect(code, "no second definition of the reader").not.toContain("function markerIn(");
    expect(code, "no second definition of the attribute").not.toContain(
      'const IDENTITY_META = "cockpit-product"',
    );
  });

  test("there is no way to a page that is not the door (a lock)", () => {
    // THE statement of this round, and the one the previous shape could not
    // make. The identity WAS asked first, on a shell page of its own, and every
    // measured route was a different document — a stand that changes hands after
    // answering was then measured for the whole run. Navigation and identity are
    // one act now, so "asked first" is not a claim anybody has to keep.
    expect(code).toContain("const stand = standAt({");
    expect(code, "no navigation outside the door").not.toContain(".goto(");
    expect(code).toContain("await stand.visit(page, target);");
  });

  test("the door names the page it opens, at every navigation (a lock)", () => {
    // In the library, because that is where the door lives. Both halves in one
    // function body: the marker is read by the same Chromium that just
    // navigated, on the page that is about to be used.
    const visit = library.slice(
      library.indexOf("async visit(page, path, options"),
      library.indexOf("frameName(page, label)"),
    );
    expect(visit, "the door is findable").not.toBe("");
    expect(visit).toContain("response = await page.goto(url, options);");
    expect(visit).toContain("const { marker, title } = await readIdentity(page);");
    expect(visit).toContain("if (problem !== null) throw refuse(problem);");
    // Withdrawn before the question, restored only by an answer: a stand that
    // changed hands has no confirmed identity, and printing the old one above
    // an abort that named another product is one report saying two things.
    expect(visit.indexOf("identity = null;")).toBeLessThan(visit.indexOf("await page.goto("));
    expect(visit).toContain("identity = marker;");
  });

  test("the report reads the identity of the LAST answer", () => {
    expect(code).toContain("stand.identity === null");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    expect(code).toContain("identity ${stand.identity} (from");
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
    // And the door refuses in this file's currency: a foreign or dead stand is
    // "not measured", never a breach somebody works off.
    expect(code).toContain("refuse: (satz, optionen) => new NichtGemessen(satz, optionen),");
    expect(code, "a refused run is not a work list").toContain(
      "if (error instanceof NichtGemessen) throw error;",
    );
  });

  test("a stand that died mid-sweep is asked about before a breach is written", () => {
    // A LOCK against silent removal, not a guard — the guard is the live
    // counter-check: kill the preview server over its port at route 11.
    // Before: exit 1 with 16 invented "page does not mount" breaches and
    // "aborted at route 27 of 27 ... 0 were never looked at". After: exit 2.
    const probe = code.indexOf("await assertStandStillAnswers(error);");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    const write = code.indexOf('breach("§6", `/${route}`, `page does not mount:');
    expect(probe, "the sweep asks whether anybody still answers").toBeGreaterThan(0);
    expect(write, "the mount breach is still written").toBeGreaterThan(0);
    expect(probe).toBeLessThan(write);
    // Asked by EFFECT: the shell is loaded again through the door, not the error
    // message parsed — so status and identity are both re-settled by the same
    // reader that would otherwise have measured the page.
    expect(code).toContain('await stand.visit(page, "", { waitUntil: "domcontentloaded" });');
  });
});

/**
 * The same question, RUN instead of read.
 *
 * Everything above this line inspects source text. This block starts a stand,
 * puts a foreign console on it and runs `scripts/konvention-check.mjs` at it.
 * Exit 2 or the guard does not exist — whatever the source says about itself.
 *
 * The four documents are the shapes that a regex over the HTTP text called
 * "SubKit" while Chromium rendered WorkKit. They are not four rules here; they
 * are one reader, and it is the browser's.
 */
describe("the convention check, run against a foreign console", () => {
  const stamp = (product: string) => `<meta name="cockpit-product" content="${product}" />`;
  const quoted = `<!--\n      The line reads:\n\n      ${stamp("SubKit")}\n    -->`;
  const page = (head: string) =>
    `<!doctype html><html><head>${head}<title>WorkKit Cockpit</title></head><body></body></html>`;

  const stands = {
    "an honest sister console": page(stamp("WorkKit")),
    "our name quoted in the prose above the stamp": page(`${quoted}${stamp("WorkKit")}`),
    "a foreign marker behind an abruptly closed <!--> comment": page(
      `<!-->${stamp("WorkKit")}${quoted}${stamp("SubKit")}`,
    ),
    "the same behind <!--->": page(`<!--->${stamp("WorkKit")}${quoted}${stamp("SubKit")}`),
    "two content attributes on one marker": page(
      '<meta name="cockpit-product" content="WorkKit" content="SubKit" />',
    ),
    "a character reference in the attribute name": page(
      `<meta name="cockpit&#45;product" content="WorkKit" />${stamp("SubKit")}`,
    ),
  };

  let served = "";
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(served);
    });
    // Port 0: several sessions of this family run at once, and a fixed port
    // measures whoever got there first.
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());

  test.each(Object.entries(stands))(
    "%s is not measured",
    async (_shape, document) => {
      served = document;
      const run = Bun.spawn(["bun", "run", "scripts/konvention-check.mjs"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          COCKPIT_BASE_URL: baseUrl,
          // The test preload moves HOME into a throwaway directory, which is also
          // where Playwright would look for its browsers.
          PLAYWRIGHT_BROWSERS_PATH: (() => {
            const parts = chromium.executablePath().split("/");
            return parts.slice(0, parts.lastIndexOf("ms-playwright") + 1).join("/");
          })(),
        },
      });
      const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
      const exitCode = await run.exited;
      // 2, not 1: a work list about a surface this repository does not own is
      // worse than no list at all.
      expect(exitCode, output).toBe(2);
      expect(output).toContain("NOT MEASURED");
      expect(output).toContain("this is not SubKit but WorkKit");
      // And the report must not carry a confirmed identity above the abort.
      expect(output).not.toContain("identity SubKit");
    },
    180_000,
  );
});

/**
 * A stand that CHANGES HANDS in the middle of the run.
 *
 * The shape the round before this one could not see. The identity was asked
 * once, on a shell page, and every answer after that belonged to somebody else.
 * The first answers here are ours — the reachability probe, the shell, the first
 * pages — and from then on a sister console holds the port.
 *
 * The real built cockpit is served so the pages actually mount; only the
 * DOCUMENT changes hands. Exit 2, and the report must not carry a confirmed
 * identity above the abort.
 */
describe("the convention check, run against a stand that changes hands", () => {
  let handOver: Server;
  let handOverUrl = "";
  let htmlAnswers = 0;
  let foreignAnswers = 0;

  beforeAll(async () => {
    const built = join(root, "assets/cockpit");
    handOver = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://x").pathname.replace(/^\/cockpit/, "");
      const asset = /\.[a-z0-9]+$/i.test(path) ? join(built, path) : null;
      if (asset !== null && existsSync(asset)) {
        const type = asset.endsWith(".js")
          ? "text/javascript"
          : asset.endsWith(".css")
            ? "text/css"
            : asset.endsWith(".svg")
              ? "image/svg+xml"
              : "application/octet-stream";
        response.writeHead(200, { "content-type": type });
        response.end(readFileSync(asset));
        return;
      }
      const ours = readFileSync(join(built, "index.html"), "utf8");
      htmlAnswers += 1;
      // Four honest answers: the reachability probe, the shell, and the first
      // pages. Everything from there on belongs to the new owner.
      const mine = htmlAnswers <= 4;
      if (!mine) foreignAnswers += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        mine
          ? ours
          : ours
              .replace(/(<meta name="cockpit-product" content=")[^"]*(")/, "$1WorkKit$2")
              .replace(/<title>[^<]*<\/title>/, "<title>WorkKit Cockpit</title>"),
      );
    });
    await new Promise<void>((done) => handOver.listen(0, "127.0.0.1", done));
    handOverUrl = `http://127.0.0.1:${(handOver.address() as AddressInfo).port}`;
  });

  afterAll(() => handOver?.close());

  test("the run stops at the first document of the new owner", async () => {
    htmlAnswers = 0;
    foreignAnswers = 0;
    const run = Bun.spawn(["bun", "run", "scripts/konvention-check.mjs"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        COCKPIT_BASE_URL: handOverUrl,
        PLAYWRIGHT_BROWSERS_PATH: (() => {
          const parts = chromium.executablePath().split("/");
          return parts.slice(0, parts.lastIndexOf("ms-playwright") + 1).join("/");
        })(),
      },
    });
    const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
    const exitCode = await run.exited;
    expect(exitCode, output).toBe(2);
    expect(output).toContain("NOT MEASURED");
    expect(output).toContain("this is not SubKit but WorkKit");
    // The identity is WITHDRAWN, not left standing from the honest answers.
    expect(output).not.toContain("identity SubKit");
    // One foreign document seen, and it is the one the run stopped on.
    expect(foreignAnswers, "it stopped at the FIRST foreign document").toBe(1);
    // And it had really started: the honest answers before the hand-over were
    // spent on pages, not on the shell alone.
    expect(htmlAnswers, "the run got past the shell before the stand changed").toBeGreaterThan(2);
  }, 180_000);
});
