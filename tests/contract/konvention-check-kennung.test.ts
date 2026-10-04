import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = readFileSync(join(root, "scripts/konvention-check.mjs"), "utf8");
const library = readFileSync(join(root, "scripts/lib/cockpit-identity.mjs"), "utf8");

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
    expect(marker, 'apps/cockpit/index.html carries <meta name="cockpit-product">').toBeTruthy();
    expect([...shell.matchAll(/name="cockpit-product"/g)]).toHaveLength(1);
  });

  test("the expected value is derived from the definition site, not typed", () => {
    expect(library).toContain(
      'export const IDENTITY_SOURCE = new URL("../../apps/cockpit/index.html", import.meta.url);',
    );
    expect(library).toContain("const expected = expectedIdentity();");
    expect(code, "no second definition site here").not.toContain('apps/cockpit/index.html"');
  });

  test("the expected value occurs exactly once in the code, as PRODUCT_NAME", () => {
    const literal = new RegExp(marker?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "", "g");
    const treffer = [...code.matchAll(literal)];
    expect(
      treffer,
      `"${marker}" occurs ${treffer.length}x in the code, exactly 1x is allowed`,
    ).toHaveLength(1);
    expect(code).toContain(`const PRODUCT_NAME = "${marker}";`);
  });

  test("the comment filter takes trailing comments and leaves strings alone", () => {
    expect(stripComments(`const a = 1; // ${marker} explains something here`)).toBe(
      "const a = 1; ",
    );
    expect(stripComments('const u = "http://127.0.0.1:4176/cockpit/";')).toBe(
      'const u = "http://127.0.0.1:4176/cockpit/";',
    );
    expect(code.split("\n")).toHaveLength(source.split("\n").length);
  });

  test("a renamed attribute is a finding about THIS repository", () => {
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
    expect(code).toContain('from "./lib/cockpit-identity.mjs"');
    expect(code, "no second definition of the reader").not.toContain("function markerIn(");
    expect(code, "no second definition of the attribute").not.toContain(
      'const IDENTITY_META = "cockpit-product"',
    );
  });

  test("there is no way to a page that is not the door (a lock)", () => {
    expect(code).toContain("const stand = standAt({");
    expect(code, "no navigation outside the door").not.toContain(".goto(");
    expect(code).toContain("await stand.visit(page, target);");
  });

  test("the door names the page it opens, at every navigation (a lock)", () => {
    const visit = library.slice(
      library.indexOf("async visit(page, path, options"),
      library.indexOf("frameName(page, label)"),
    );
    expect(visit, "the door is findable").not.toBe("");
    expect(visit).toContain("response = await page.goto(url, options);");
    expect(visit).toContain("const { marker, title } = await readIdentity(page);");
    expect(visit).toContain("if (problem !== null) throw refuse(problem);");
    expect(visit.indexOf("identity = null;")).toBeLessThan(visit.indexOf("await page.goto("));
    expect(visit).toContain("identity = marker;");
  });

  test("the report reads the identity of the LAST answer", () => {
    expect(code).toContain("stand.identity === null");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    expect(code).toContain("identity ${stand.identity} (from");
  });

  test('"not measured" has an exit code of its own', () => {
    expect(code).toContain("class NichtGemessen extends Error {}");
    expect(code).toContain("process.exit(nichtGemessen ? 2 : 1);");
    expect(code).toContain(
      "const nichtGemessen = abbruch instanceof NichtGemessen || (Boolean(abbruch) && !routenDurchlaufen);",
    );
    expect(code).toContain("routenDurchlaufen = true;");
    expect(code).toContain("refuse: (satz, optionen) => new NichtGemessen(satz, optionen),");
    expect(code, "a refused run is not a work list").toContain(
      "if (error instanceof NichtGemessen) throw error;",
    );
  });

  test("a stand that died mid-sweep is asked about before a breach is written", () => {
    const probe = code.indexOf("await assertStandStillAnswers(error);");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    const write = code.indexOf('breach("§6", `/${route}`, `page does not mount:');
    expect(probe, "the sweep asks whether anybody still answers").toBeGreaterThan(0);
    expect(write, "the mount breach is still written").toBeGreaterThan(0);
    expect(probe).toBeLessThan(write);
    expect(code).toContain('await stand.visit(page, "", { waitUntil: "domcontentloaded" });');
  });
});

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
      expect(output).not.toContain("identity SubKit");
    },
    180_000,
  );
});

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
    expect(output).not.toContain("identity SubKit");
    expect(foreignAnswers, "it stopped at the FIRST foreign document").toBe(1);
    expect(htmlAnswers, "the run got past the shell before the stand changed").toBeGreaterThan(2);
  }, 180_000);
});
