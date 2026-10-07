import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { waitFor } from "../../apps/engine/src/test-helpers/determinism/wait.ts";
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

function browsersPath() {
  const parts = chromium.executablePath().split("/");
  return parts.slice(0, parts.lastIndexOf("ms-playwright") + 1).join("/");
}

let served = "";
let server: Server;
let baseUrl = "";
let browser: Browser;
let recordSweepProcesses: (() => void) | null = null;

function ownedBrowserProcesses(pid: number): number[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,comm="], { stdout: "pipe" });
  expect(result.exitCode).toBe(0);
  const processes = result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .flatMap((match) =>
      match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] ?? "" }] : [],
    );
  const owned = new Set([pid]);
  let previousSize = 0;
  while (previousSize !== owned.size) {
    previousSize = owned.size;
    for (const process of processes) if (owned.has(process.parent)) owned.add(process.pid);
  }
  return processes
    .filter((process) => owned.has(process.pid) && /chrome|chromium/i.test(process.command))
    .map((process) => process.pid);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

beforeAll(async () => {
  server = createServer((_request, response) => {
    recordSweepProcesses?.();
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

  test("the sweep itself takes no frame of a foreign console", async () => {
    served = traps.abruptlyClosedComment;
    const outputDir = join(root, ".artifacts/cockpit-sweep/identity-contract");
    rmSync(outputDir, { recursive: true, force: true });
    const run = Bun.spawn(["bun", "run", "scripts/verify-cockpit-visual.mjs"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: root,
      env: {
        ...process.env,
        COCKPIT_BASE_URL: baseUrl,
        COCKPIT_SCREENSHOT_DIR: outputDir,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath(),
      },
    });
    const browserPids = new Set<number>();
    recordSweepProcesses = () => {
      for (const pid of ownedBrowserProcesses(run.pid)) browserPids.add(pid);
    };
    let output: string;
    let exitCode: number;
    try {
      output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
      exitCode = await run.exited;
    } finally {
      recordSweepProcesses = null;
    }
    expect(exitCode, output).not.toBe(0);
    expect(output).toContain("NOT TAKEN");
    expect(output).toContain("this is not SubKit but WorkKit");
    expect(existsSync(outputDir), "not one frame was written").toBe(false);
    expect(browserPids.size, "the failed sweep actually owned a browser process").toBeGreaterThan(
      0,
    );
    await waitFor(() => [...browserPids].every((pid) => !processExists(pid)), {
      tries: 100,
      sleepMs: 20,
      label: "failed visual sweep browser shutdown",
    });
    expect([...browserPids].filter(processExists)).toEqual([]);
  }, 120_000);
});

describe("a stand that changes hands mid-run photographs nothing of the new owner", () => {
  const root2 = root;
  let handOver: Server;
  let handOverUrl = "";
  let htmlAnswers = 0;
  let foreignAnswers = 0;
  let switchAfter = 1;

  beforeAll(async () => {
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

  afterAll(() => closeServer(handOver), 30_000);

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
    expect(foreignAnswers, "it stopped at the FIRST foreign document").toBe(1);
    const frames = existsSync(outputDir) ? readdirSync(outputDir) : [];
    expect(frames.length, frames.join(", ")).toBeLessThanOrEqual(1);
    expect(
      frames.every((name) => name.startsWith("subkit-")),
      frames.join(", "),
    ).toBe(true);
  }, 180_000);
});
