import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import {
  expectedIdentity,
  IDENTITY_META,
  identityProblem,
  markerIn,
  readIdentity,
} from "../../scripts/lib/cockpit-identity.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const shell = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;

const withProse = (example: string, head: string) =>
  shell(`<!--\n      Whose console this is. The line reads:\n\n${example}\n    -->\n    ${head}`);

const quotedStamp = `      <meta name="${IDENTITY_META}" content="SubKit" />`;

const fixtures = {
  ours: readFileSync(join(root, "apps/cockpit/index.html"), "utf8"),
  sister: shell(`<title>WorkKit</title><meta name="${IDENTITY_META}" content="WorkKit" />`),
  beforeTheMarker: shell("<title>SubKit Cockpit</title>"),
  empty: "",
  vitePlaceholder: shell("<title>Vite App</title>"),
  sisterQuotingUs: withProse(
    quotedStamp,
    `<meta name="${IDENTITY_META}" content="WorkKit" /><title>WorkKit Cockpit</title>`,
  ),
  beforeTheMarkerQuotingIt: withProse(quotedStamp, "<title>WorkKit Cockpit</title>"),
  titleOnlyInProse: withProse(
    "      <title>SubKit Cockpit</title>",
    "<title>WorkKit Cockpit</title>",
  ),
};

const traps = {
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
  duplicateContent: shell(
    `<meta name="${IDENTITY_META}" content="WorkKit" content="SubKit" />` +
      "<title>WorkKit Cockpit</title>",
  ),
  charRefInAttributeValue: shell(
    `<meta name="${IDENTITY_META}" content="Work&#75;it" /><title>WorkKit Cockpit</title>`,
  ),
  charRefInAttributeName: shell(
    `<meta name="cockpit&#45;product" content="WorkKit" />` +
      `<meta name="${IDENTITY_META}" content="SubKit" /><title>WorkKit Cockpit</title>`,
  ),
};

let served = "";
let server: Server;
let baseUrl = "";
let browser: Browser;
beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(served);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

async function closeServer(testServer: Server | undefined): Promise<void> {
  if (!testServer?.listening) return;
  await new Promise<void>((resolve, reject) => {
    testServer.close((error) => (error ? reject(error) : resolve()));
    testServer.closeAllConnections();
  });
}

afterAll(async () => {
  const results = await Promise.allSettled([browser?.close(), closeServer(server)]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Cockpit identity test resources could not be closed.",
    );
}, 30_000);

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
    const problem = await problemFor(fixtures.beforeTheMarker);
    expect(problem).toContain("carries no");
    expect(problem).toContain('Its title reads "SubKit Cockpit"');
  });

  test("an empty and a placeholder document are rejected too", async () => {
    expect(await problemFor(fixtures.empty)).toContain("(no <title>)");
    expect(await problemFor(fixtures.vitePlaceholder)).toContain('Its title reads "Vite App"');
  });

  test("a lost marker is a finding about THIS repository", async () => {
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
      const { marker } = await asServed(document);
      expect(marker).toBe("WorkKit");
      expect(await problemFor(document)).toContain("this is not SubKit but WorkKit");
    },
  );

  test("the text fallback answers null wherever a parser could disagree", () => {
    for (const [shape, document] of Object.entries(traps))
      expect(markerIn(document), `${shape} must not yield a guessed name`).toBeNull();
    expect(markerIn(`<!-- <meta name="${IDENTITY_META}" content="SubKit" />`)).toBeNull();
    expect(markerIn(shell(`<meta name="${IDENTITY_META}" content="Work&#75;it" />`))).toBeNull();
    expect(markerIn(shell(`<meta name="${IDENTITY_META}" content="Sub&amp;Kit" />`))).toBeNull();
    expect(markerIn(shell(""))).toBeNull();
    expect(markerIn(fixtures.ours)).toBe("SubKit");
    expect(markerIn(fixtures.sister)).toBe("WorkKit");
  });

  test("the prose fixtures have the shape the real shell has", () => {
    const comment = fixtures.ours.indexOf("<!--");
    const stamp = fixtures.ours.indexOf(`name="${IDENTITY_META}"`);
    expect(comment, "the real shell carries a comment").toBeGreaterThan(-1);
    expect(comment, "and it stands ahead of the stamp").toBeLessThan(stamp);
    expect(fixtures.sisterQuotingUs.indexOf("<!--")).toBeLessThan(
      fixtures.sisterQuotingUs.indexOf(`content="WorkKit"`),
    );
  });
});
