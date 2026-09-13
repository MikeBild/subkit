// The identity question, driven through the browser that takes the frames.
//
// The rule this file obeys: a guard that checks TEXT instead of EFFECT is not a
// guard. It cost this repository four rounds. A sister repo pinned its identity
// rule as "the line is present"; an implementation that left the line in place
// and asked the wrong document passed 12/0 with the hole fully open. Then the
// reader here was sharpened against prose — and the sharpening OPENED the next
// hole: a comment stripper that swallows `<!-->` swallows the foreign marker
// behind it, and the sweep wrote 296 frames of a WorkKit cockpit at exit 0.
// Then the reader became the browser and the hole moved AGAIN, one level up:
// the right reader was asked ONCE, on a page of its own, before the first
// frame. Against a stand that changes hands after answering, that bought one
// honest answer and 240 foreign documents — exit 0, 296 frames. The last
// describe() in this file is that stand.
//
// So the fixtures below are not handed to a function. They are SERVED over real
// HTTP and read by a real Chromium — the same engine, the same parse and the
// same document the screenshots come from. The four shapes that still beat a
// regex are the point of the file.
//
// tests/contract/ because CI's shard job runs `apps packages` only
// (LOCAL-SK-SCRIPTS-TESTS-NICHT-IN-CI). `bun run test:contract` runs this.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium } from "playwright";

import {
  expectedIdentity,
  IDENTITY_META,
  identityProblem,
  markerIn,
  readIdentity,
} from "../../scripts/lib/cockpit-identity.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The documents a sweep can meet on a port. */
const shell = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;

/**
 * A shell in the shape of a REAL one: prose first, and the prose quotes the
 * stamp as an example before the document carries its own.
 *
 * The prose is invented here, its POSITION is not: the last test below holds
 * this fixture against the real document, so the shape cannot drift into one
 * that no console has.
 */
const withProse = (example: string, head: string) =>
  shell(`<!--\n      Whose console this is. The line reads:\n\n${example}\n    -->\n    ${head}`);

const quotedStamp = `      <meta name="${IDENTITY_META}" content="SubKit" />`;

const fixtures = {
  ours: readFileSync(join(root, "apps/cockpit/index.html"), "utf8"),
  sister: shell(`<title>WorkKit</title><meta name="${IDENTITY_META}" content="WorkKit" />`),
  beforeTheMarker: shell("<title>SubKit Cockpit</title>"),
  empty: "",
  vitePlaceholder: shell("<title>Vite App</title>"),
  // The stand the counter-check served on 4175: a real built cockpit, stamped
  // WorkKit, with our own name quoted in the comment above the stamp.
  sisterQuotingUs: withProse(
    quotedStamp,
    `<meta name="${IDENTITY_META}" content="WorkKit" /><title>WorkKit Cockpit</title>`,
  ),
  // The 13-day-old orphan, but with prose that names the marker it lacks.
  beforeTheMarkerQuotingIt: withProse(quotedStamp, "<title>WorkKit Cockpit</title>"),
  // Same trap one line down: the title is what the rejection sentence PRINTS.
  titleOnlyInProse: withProse(
    "      <title>SubKit Cockpit</title>",
    "<title>WorkKit Cockpit</title>",
  ),
};

/**
 * The four shapes a regex loses against, and the browser does not.
 *
 * Every one of them is a WorkKit console that a text reader called SubKit — the
 * first two were measured end to end at exit 0 with 296 frames of a foreign
 * cockpit. They are listed together because they are ONE finding: a document has
 * as many identities as it has readers.
 */
const traps = {
  // `<!-->` is a COMPLETE, abruptly closed, empty comment. The parser sees two
  // live markers after it and takes the first; a reader that treats it as a
  // comment OPENING strips to the next `-->` and swallows exactly the foreign
  // one. This shape was created by the repair of the shape before it.
  abruptlyClosedComment: shell(
    `<!--><meta name="${IDENTITY_META}" content="WorkKit" />` +
      `<!--\n      The line reads:\n\n${quotedStamp}\n    -->` +
      `<meta name="${IDENTITY_META}" content="SubKit" /><title>WorkKit Cockpit</title>`,
  ),
  abruptlyClosedCommentDash: shell(
    `<!---><meta name="${IDENTITY_META}" content="WorkKit" />` +
      `<!--\n      The line reads:\n\n${quotedStamp}\n    -->` +
      `<meta name="${IDENTITY_META}" content="SubKit" /><title>WorkKit Cockpit</title>`,
  ),
  // The parser keeps the FIRST `content`; a reader looking for `content=` after
  // `name=` finds the second.
  duplicateContent: shell(
    `<meta name="${IDENTITY_META}" content="WorkKit" content="SubKit" />` +
      "<title>WorkKit Cockpit</title>",
  ),
  // Chromium decodes character references in the attribute VALUE too, so the
  // marker reads WorkKit while a string comparison reads `Work&#75;it`. Served
  // over real HTTP, not handed to a function: 23 shapes were driven through this
  // stand and this is the one from the parser class that still got through.
  charRefInAttributeValue: shell(
    `<meta name="${IDENTITY_META}" content="Work&#75;it" /><title>WorkKit Cockpit</title>`,
  ),
  // Chromium decodes character references in the attribute NAME, so this IS the
  // marker to the parser and is not to a string comparison — which then walks on
  // and finds the harmless-looking one behind it.
  charRefInAttributeName: shell(
    `<meta name="cockpit&#45;product" content="WorkKit" />` +
      `<meta name="${IDENTITY_META}" content="SubKit" /><title>WorkKit Cockpit</title>`,
  ),
};

/** Where THIS process found its Chromium, for a child that must find the same one. */
function browsersPath() {
  const parts = chromium.executablePath().split("/");
  return parts.slice(0, parts.lastIndexOf("ms-playwright") + 1).join("/");
}

/** Serves whatever the current test put on the counter, at /cockpit/. */
let served = "";
let server: Server;
let baseUrl = "";
let browser: Browser;

// A COLD CHROMIUM START IS NOT A DEFECT, and Bun's default budget for a hook is
// 5 s. This one measured 5006.99 ms on this machine — 1 run in 6 went red, and
// because a failing `beforeAll` takes its whole describe with it, the run then
// cost 124 s instead of 10 and reported a launch error instead of the tests it
// never ran. On a runner the first launch is colder than here: the binary is
// not in the page cache, and nothing has ever executed it.
//
// So the budget is stated rather than inherited. It is not a slow test being
// waved through — the launch takes well under a second once warm; it is the
// wall being put where a cold start cannot reach it.
beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(served);
  });
  // Port 0: several sessions of this family run at once, and a fixed port is a
  // measurement of whoever got there first.
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

/** What the CAMERA says the document is — the only reader this repo has left. */
async function asServed(document: string) {
  served = document;
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/cockpit/`, { waitUntil: "domcontentloaded" });
    return await readIdentity(page);
  } finally {
    await page.close();
  }
}

async function problemFor(document: string, expected: string | null = "SubKit") {
  const { marker, title } = await asServed(document);
  return identityProblem({ delivered: marker, title, expected, baseUrl });
}

describe("the visual sweep asks whose console it is photographing", () => {
  test("the definition site names the console exactly once", () => {
    expect(expectedIdentity(), "apps/cockpit/index.html carries the marker").toBe("SubKit");
    expect([...fixtures.ours.matchAll(new RegExp(`name="${IDENTITY_META}"`, "g"))]).toHaveLength(1);
  });

  test("our own served document passes", async () => {
    expect(await problemFor(fixtures.ours)).toBeNull();
  });

  test("a sister console is named, not merely rejected", async () => {
    const problem = await problemFor(fixtures.sister);
    expect(problem).toContain("this is not SubKit but WorkKit");
    expect(problem).toContain(baseUrl);
  });

  test("a build from before the marker is rejected, with its title", async () => {
    // The 13-day-old orphan on 4080 was exactly this: no marker at all.
    const problem = await problemFor(fixtures.beforeTheMarker);
    expect(problem).toContain("carries no");
    expect(problem).toContain('Its title reads "SubKit Cockpit"');
  });

  test("an empty and a placeholder document are rejected too", async () => {
    expect(await problemFor(fixtures.empty)).toContain("(no <title>)");
    expect(await problemFor(fixtures.vitePlaceholder)).toContain('Its title reads "Vite App"');
  });

  test("a lost marker is a finding about THIS repository", async () => {
    // Not "foreign document" about our own console — the direction a sister repo
    // got backwards.
    expect(await problemFor(fixtures.ours, null)).toContain("a finding about THIS repository");
  });

  test("a marker quoted in prose is not the document's marker", async () => {
    expect(await problemFor(fixtures.sisterQuotingUs)).toContain("this is not SubKit but WorkKit");
    const orphan = await problemFor(fixtures.beforeTheMarkerQuotingIt);
    expect(orphan).toContain("carries no");
    expect(orphan).toContain('Its title reads "WorkKit Cockpit"');
  });

  test("the console is named by its own title, not by one quoted in prose", async () => {
    const problem = await problemFor(fixtures.titleOnlyInProse);
    expect(problem).toContain('Its title reads "WorkKit Cockpit"');
    expect(problem).not.toContain("SubKit Cockpit");
  });

  test.each(Object.entries(traps))(
    "a WorkKit console hiding behind %s is still WorkKit",
    async (_shape, document) => {
      // Each of these was read as "SubKit" by a regex over the HTTP text. The
      // browser reads the document it renders, so there is nothing to hide
      // behind — and none of them needed a rule of its own.
      const { marker } = await asServed(document);
      expect(marker).toBe("WorkKit");
      expect(await problemFor(document)).toContain("this is not SubKit but WorkKit");
    },
  );

  test("the text fallback answers null wherever a parser could disagree", () => {
    // `markerIn` still reads the definition site on disk, where no browser is
    // open. Its rule there is not "read it as well as you can" but "refuse
    // anything ambiguous": null becomes exit 2 at every caller, never a name.
    for (const [shape, document] of Object.entries(traps))
      expect(markerIn(document), `${shape} must not yield a guessed name`).toBeNull();
    expect(markerIn(`<!-- <meta name="${IDENTITY_META}" content="SubKit" />`)).toBeNull();
    // A character reference in the VALUE, which the rule above skipped for three
    // rounds while covering the same thing in the NAME. Chromium reads WorkKit;
    // a string comparison reads `Work&#75;it`. Refusing to name it is the only
    // safe answer, here as everywhere else in this function.
    expect(markerIn(shell(`<meta name="${IDENTITY_META}" content="Work&#75;it" />`))).toBeNull();
    expect(markerIn(shell(`<meta name="${IDENTITY_META}" content="Sub&amp;Kit" />`))).toBeNull();
    expect(markerIn(shell(""))).toBeNull();
    // And it still reads an honest document honestly, or the definition site
    // could never be named at all.
    expect(markerIn(fixtures.ours)).toBe("SubKit");
    expect(markerIn(fixtures.sister)).toBe("WorkKit");
  });

  test("the prose fixtures have the shape the real shell has", () => {
    // Without this the prose fixtures would be a shape invented for the test.
    // The real shell puts a comment ahead of its stamp; so do they.
    const comment = fixtures.ours.indexOf("<!--");
    const stamp = fixtures.ours.indexOf(`name="${IDENTITY_META}"`);
    expect(comment, "the real shell carries a comment").toBeGreaterThan(-1);
    expect(comment, "and it stands ahead of the stamp").toBeLessThan(stamp);
    expect(fixtures.sisterQuotingUs.indexOf("<!--")).toBeLessThan(
      fixtures.sisterQuotingUs.indexOf(`content="WorkKit"`),
    );
  });

  test("the sweep itself takes no frame of a foreign console", async () => {
    // End to end, and the only statement that matters: the script is RUN
    // against a trap stand. Before the browser became the reader this exact
    // document produced exit 0 and 296 screenshots titled "WorkKit Cockpit".
    served = traps.abruptlyClosedComment;
    const outputDir = join(root, ".artifacts/cockpit-sweep/identity-contract");
    rmSync(outputDir, { recursive: true, force: true });
    // Spawned, not spawnSync: the trap stand is served from THIS process, and a
    // blocking child would leave it unable to answer its own child's request.
    const run = Bun.spawn(["bun", "run", "scripts/verify-cockpit-visual.mjs"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: root,
      env: {
        ...process.env,
        COCKPIT_BASE_URL: baseUrl,
        COCKPIT_SCREENSHOT_DIR: outputDir,
        // The test preload moves HOME into a throwaway directory, and that is
        // also where Playwright would look for its browsers. Handed down
        // explicitly rather than handing the child the real HOME back.
        PLAYWRIGHT_BROWSERS_PATH: browsersPath(),
      },
    });
    const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
    const exitCode = await run.exited;
    expect(exitCode, output).not.toBe(0);
    expect(output).toContain("NOT TAKEN");
    expect(output).toContain("this is not SubKit but WorkKit");
    expect(existsSync(outputDir), "not one frame was written").toBe(false);
  }, 120_000);
});

/**
 * A stand that CHANGES HANDS after its first answer — the shape that survived
 * three repairs of the reader.
 *
 * Upstream is this repository's own shell. The first HTML answer goes out as
 * delivered, which is the answer an identity question gets; every one after it
 * carries WorkKit. Nothing about the reader is wrong here — the reader was asked
 * once and told the truth once.
 *
 * Measured against the version before this file's `standAt()`: exit 0, 296
 * frames, 1 SubKit answer against 240 WorkKit ones. The sweep is RUN, and the
 * only statements that count are its exit code and the files on disk.
 */
describe("a stand that changes hands mid-run photographs nothing of the new owner", () => {
  const root2 = root;
  let handOver: Server;
  let handOverUrl = "";
  let htmlAnswers = 0;
  let foreignAnswers = 0;
  /** Answers 1..switchAfter are ours; everything after belongs to somebody else. */
  let switchAfter = 1;

  beforeAll(async () => {
    // The REAL built cockpit, so the pages actually mount and the run gets far
    // enough to have something to take. Only the document changes hands;
    // everything else is served as built.
    const built = join(root2, "assets/cockpit");
    handOver = createServer(async (request, response) => {
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
      const mine = htmlAnswers <= switchAfter;
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

  test("the sweep stops at the first document of the new owner", async () => {
    htmlAnswers = 0;
    foreignAnswers = 0;
    switchAfter = 1;
    const outputDir = join(root2, ".artifacts/cockpit-sweep/hand-over-contract");
    rmSync(outputDir, { recursive: true, force: true });
    const run = Bun.spawn(["bun", "run", "scripts/verify-cockpit-visual.mjs"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: root2,
      env: {
        ...process.env,
        COCKPIT_BASE_URL: handOverUrl,
        COCKPIT_SCREENSHOT_DIR: outputDir,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath(),
      },
    });
    const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
    const exitCode = await run.exited;
    expect(exitCode, output).not.toBe(0);
    expect(output).toContain("NOT TAKEN");
    expect(output).toContain("this is not SubKit but WorkKit");
    // THE number: how many documents of the new owner the run saw before it
    // stopped. One — the one it stopped on. The version before `standAt()` saw
    // 240 of them and photographed every one.
    expect(foreignAnswers, "it stopped at the FIRST foreign document").toBe(1);
    // And what it left behind is only what it took while the stand was still
    // ours — one frame, from the one navigation that got an honest answer, and
    // it carries that answer in its name.
    const frames = existsSync(outputDir) ? readdirSync(outputDir) : [];
    expect(frames.length, frames.join(", ")).toBeLessThanOrEqual(1);
    expect(
      frames.every((name) => name.startsWith("subkit-")),
      frames.join(", "),
    ).toBe(true);
  }, 180_000);
});
