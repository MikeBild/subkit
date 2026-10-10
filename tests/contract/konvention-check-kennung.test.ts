import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    expect(code).toContain("let stand = standAt({");
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
    expect(code.replace(/\s+/g, " ")).toContain(
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
