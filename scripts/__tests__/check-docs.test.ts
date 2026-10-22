import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCS_SECTIONS, type DocsBundle, DocsBundleSchema } from "@shared/llms-index.ts";
import { checkDocs, type DocsPaths, type Finding } from "../check-docs.ts";
import { headings, images, servedImageSrc } from "../docs-source.ts";

let root: string;
let paths: DocsPaths;

interface PageSpec {
  slug: string;
  llms_path: string | null;
  generated: boolean;
  en: string;
  de: string;
}

const EN_GUIDE =
  "# Guide\n\nRead the [details](#details) and [the reference](cli.md#commands).\n\n## Details\n\nCall https://api.stripe.com/v1 or https://shop1.myshopify.com from http://localhost:3000.\n";
const DE_GUIDE =
  "# Anleitung\n\nLies die [Details](#einzelheiten) und [die Referenz](cli.md#befehle).\n\n## Einzelheiten\n\nRufe https://api.stripe.com/v1 auf.\n";
const EN_CLI =
  "# CLI\n\n## Commands\n\nRun `sk` at 127.0.0.1 or https://github.com/example/tool.\n";
const DE_CLI = "Die Befehlsreferenz bleibt auf Englisch.\n\n# CLI\n\n## Befehle\n\nRun `sk`.\n";

let pages: PageSpec[];
let chapters: Record<string, string>;
let llmsPagePaths: string[];
let seed: string;
let imageFiles: Record<string, Uint8Array>;
let manifest: Record<string, { sha256: string; build: string }>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-docs-"));
  paths = {
    referenceDir: join(root, "reference"),
    llmsDir: join(root, "llms"),
    cockpitDocs: join(root, "docs.generated.ts"),
    seedDir: join(root, "seeds"),
    templates: join(root, "templates.json"),
  };
  pages = [
    { slug: "guide", llms_path: "guide.md", generated: false, en: EN_GUIDE, de: DE_GUIDE },
    { slug: "cli", llms_path: "cli.md", generated: true, en: EN_CLI, de: DE_CLI },
  ];
  chapters = {
    "guide.en.md":
      "---\nslug: guide\nsection: start\norder: 1\naudience: public\n---\n## Details\n",
    "guide.de.md":
      "---\nslug: guide\nsection: start\norder: 1\naudience: public\n---\n## Einzelheiten\n",
    "cli.de.md":
      "---\nslug: cli\nsection: start\norder: 2\naudience: public\n---\nDie Befehlsreferenz bleibt auf Englisch.\n",
  };
  llmsPagePaths = ["guide.md", "cli.md"];
  imageFiles = {};
  manifest = {};
  seed = "---\nslug: sk-ref-guide\ngenerated: true\n---\n\n# Guide\n";
  writeFileSync(
    paths.templates,
    JSON.stringify([
      { slug: "stripe", base_url: "https://api.stripe.com/v1" },
      { slug: "shopify", base_url: "https://{shop}.myshopify.com/admin/api" },
    ]),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function content(body: string) {
  return {
    title: body.match(/^#\s+(.+)$/m)?.[1] ?? "",
    summary: "",
    headings: headings(body),
    images: images(body),
    sha256: "0",
    body,
  };
}

function run(): Finding[] {
  rmSync(paths.referenceDir, { recursive: true, force: true });
  mkdirSync(paths.referenceDir, { recursive: true });
  mkdirSync(paths.llmsDir, { recursive: true });
  mkdirSync(paths.seedDir, { recursive: true });
  for (const [file, text] of Object.entries(chapters))
    writeFileSync(join(paths.referenceDir, file), text);
  if (Object.keys(imageFiles).length > 0 || Object.keys(manifest).length > 0) {
    const imagesDir = join(paths.referenceDir, "images");
    mkdirSync(imagesDir, { recursive: true });
    for (const [file, bytes] of Object.entries(imageFiles))
      writeFileSync(join(imagesDir, file), bytes);
    writeFileSync(join(imagesDir, "manifest.json"), JSON.stringify(manifest));
  }
  const bundle: DocsBundle = DocsBundleSchema.parse({
    locales: ["en", "de"],
    sections: DOCS_SECTIONS,
    pages: pages.map((p, index) => ({
      slug: p.slug,
      llms_path: p.llms_path,
      audience: "public",
      section: "start",
      order: index + 1,
      generated: p.generated,
      locales: { en: content(p.en), de: content(p.de) },
    })),
  });
  const json = JSON.stringify(bundle, null, 2);
  writeFileSync(join(paths.llmsDir, "docs.json"), `${json}\n`);
  writeFileSync(
    paths.cockpitDocs,
    `import type { DocsBundle } from "@shared/llms-index.ts";\n\nexport const DOCS: DocsBundle = ${json};\n`,
  );
  const sections = new Map<string, string[]>();
  for (const p of pages) {
    if (p.llms_path) sections.set(p.llms_path, [...(sections.get(p.llms_path) ?? []), p.en]);
  }
  const full = [
    "# sk\n\n- [Guide](llms/guide.md)\n- [CLI](llms/cli.md)",
    ...[...sections].map(([path, bodies]) => `\n<!-- Source: ${path} -->\n\n${bodies.join("\n")}`),
  ].join("\n");
  writeFileSync(join(paths.llmsDir, "llms-full.txt"), `${full}\n`);
  writeFileSync(join(paths.seedDir, "guide.md"), seed);
  return checkDocs(paths, { llmsPagePaths, version: "10.4.12" });
}

function rules(findings: Finding[]): string[] {
  return [...new Set(findings.map((f) => f.rule))];
}

interface WebpSpec {
  width?: number;
  height?: number;
  flags?: number;
  padding?: number;
}

function webp({ width = 800, height = 600, flags = 0, padding = 0 }: WebpSpec = {}): Uint8Array {
  const extra = padding > 0 ? 8 + padding : 0;
  const out = new Uint8Array(30 + extra);
  const view = new DataView(out.buffer);
  const text = (value: string, at: number) => out.set(new TextEncoder().encode(value), at);
  text("RIFF", 0);
  view.setUint32(4, out.length - 8, true);
  text("WEBPVP8X", 8);
  view.setUint32(16, 10, true);
  out[20] = flags;
  const u24 = (value: number, at: number) =>
    out.set([value & 0xff, (value >> 8) & 0xff, value >> 16], at);
  u24(width - 1, 24);
  u24(height - 1, 27);
  if (padding > 0) {
    text("PADD", 30);
    view.setUint32(34, padding, true);
  }
  return out;
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function addImage(
  locale: "en" | "de",
  options: { name?: string; alt?: string; spec?: WebpSpec; build?: string } = {},
): string {
  const file = `${options.name ?? "guide-run"}.${locale}.webp`;
  const bytes = webp(options.spec);
  imageFiles[file] = bytes;
  manifest[file] = { sha256: sha(bytes), build: options.build ?? "10.4.0" };
  guide()[locale] += `\n![${options.alt ?? "Run result"}](${servedImageSrc(file, sha(bytes))})\n`;
  return file;
}

function imageDetails(findings: Finding[]): string[] {
  expect(rules(findings)).toEqual(["image"]);
  return findings.map((f) => f.detail);
}

function guide(): PageSpec {
  const page = pages[0];
  if (!page) throw new Error("fixture has no guide page");
  return page;
}

describe("checkDocs", () => {
  test("accepts the minimal valid tree", () => {
    expect(run()).toEqual([]);
  });

  test("rejects a private wiki link", () => {
    guide().en += "\nSee https://github.com/MikeBild/subkit/wiki/Clippings.\n";
    const findings = run();
    expect(rules(findings)).toEqual(["host"]);
    expect(findings[0]?.detail).toContain("github.com");
  });

  test("allows a public github link", () => {
    guide().en += "\nSee https://github.com/MikeBild/subkit/releases.\n";
    expect(run()).toEqual([]);
  });

  test("rejects a private issue path without a scheme", () => {
    guide().de += "\nSiehe github.com/MikeBild/subkit/issues/1.\n";
    expect(rules(run())).toEqual(["host"]);
  });

  test("accepts placeholder hosts", () => {
    guide().en += "\nConnect https://<engine-host>/mcp or https://{shop}.myshopify.com/admin.\n";
    expect(run()).toEqual([]);
  });

  test("rejects a bearer token", () => {
    guide().en += `\nAuthorization: Bearer ${"abc1234567"}${"9".repeat(20)}\n`;
    expect(rules(run())).toEqual(["secret"]);
  });

  test("rejects a live secret key in a generated seed", () => {
    seed += `\n${"sk_"}${"live_"}${"a".repeat(24)}\n`;
    const findings = run();
    expect(rules(findings)).toEqual(["secret"]);
    expect(findings[0]?.file).toBe(join(paths.seedDir, "guide.md"));
  });

  test("rejects a raw IP address", () => {
    guide().de += "\nDie Engine läuft auf 203.0.113.7.\n";
    expect(rules(run())).toEqual(["ip"]);
  });

  test("rejects a raw IPv6 address", () => {
    guide().en += "\nThe engine listens on fd00::7.\n";
    expect(rules(run())).toEqual(["ip"]);
  });

  test("rejects an internal hostname", () => {
    guide().en += "\nThe database runs on db.cluster.internal.\n";
    expect(rules(run())).toEqual(["host"]);
  });

  test("rejects a host that no template or allowlist names", () => {
    guide().en += "\nSend it to https://hooks.vendor.io/in.\n";
    expect(rules(run())).toEqual(["host"]);
  });

  test("rejects a key-file name", () => {
    guide().en += "\nCopy ~/.ssh/id_ed25519 to the server.\n";
    expect(rules(run())).toEqual(["key-file"]);
  });

  test.each([
    ["an underscore key file", "Load the key from ~/keys/provider_key.txt.", "key-file"],
    ["a hyphen key file", "Point the release at primary-key.txt.", "key-file"],
    ["an uppercase key file", "Keep FALLBACK_KEY.TXT outside the repository.", "key-file"],
    ["the evidence directory", "Screenshots land in .artifacts/acceptance/run.png.", "local-only"],
    ["the demo URL variable", "Export SUBKIT_DEMO_URL before you start.", "local-only"],
    ["a demo command", "Run `bun run demo:local:verify` first.", "local-only"],
  ])("rejects %s", (_name, line, rule) => {
    guide().en += `\n${line}\n`;
    expect(rules(run())).toEqual([rule]);
  });

  test("accepts near misses of local-only names", () => {
    guide().en += `\nSet SK_API_KEY or \${SK_API_KEY}, read key.txt docs, and keep build artifacts/ out of http://localhost:3000/demo.\n`;
    expect(run()).toEqual([]);
  });

  test("resolves anchors across chapters that share an llms page", () => {
    pages.push({
      slug: "more",
      llms_path: "guide.md",
      generated: false,
      en: "# More\n\n## Extra\n\nBack to [details](guide.md#details).\n",
      de: "# Mehr\n\n## Zusatz\n\nZurück zu [Einzelheiten](guide.md#einzelheiten).\n",
    });
    guide().en += "\nSee [extra](guide.md#extra).\n";
    chapters["more.en.md"] =
      "---\nslug: more\nsection: start\norder: 3\naudience: public\n---\n## Extra\n";
    chapters["more.de.md"] =
      "---\nslug: more\nsection: start\norder: 3\naudience: public\n---\n## Zusatz\n";
    expect(run()).toEqual([]);
  });

  test("rejects an authored chapter without .de.md", () => {
    chapters["extra.en.md"] =
      "---\nslug: extra\nsection: start\norder: 3\naudience: public\n---\n## Extra\n";
    const findings = run();
    expect(rules(findings)).toEqual(["translation"]);
    expect(findings[0]?.detail).toBe("extra has no .de.md");
  });

  test("rejects a German chapter in another section or position", () => {
    chapters["guide.de.md"] =
      chapters["guide.de.md"]?.replace("section: start", "section: work") ?? "";
    const findings = run();
    expect(rules(findings)).toEqual(["translation"]);
    expect(findings[0]?.detail).toBe("guide is start/1 in en but work/1 in de");
  });

  test("rejects unequal heading counts", () => {
    chapters["guide.de.md"] += "### Mehr\n";
    expect(rules(run())).toEqual(["translation"]);
  });

  test("rejects a generated page without a DE intro", () => {
    delete chapters["cli.de.md"];
    const findings = run();
    expect(rules(findings)).toEqual(["translation"]);
    expect(findings[0]?.detail).toBe("generated cli has no DE intro");
  });

  test("rejects a broken anchor", () => {
    guide().de = guide().de.replace("#einzelheiten", "#details");
    const findings = run();
    expect(rules(findings)).toEqual(["link"]);
    expect(findings[0]?.detail).toContain("#details has no matching de heading");
  });

  test("rejects a link to an unpublished page", () => {
    guide().en += "\nSee [missing](missing.md).\n";
    expect(rules(run())).toEqual(["link"]);
  });

  test("rejects an image without alt text", () => {
    chapters["shot.png"] = "png";
    guide().en += "\n![](shot.png)\n";
    const findings = run();
    expect(rules(findings)).toEqual(["image"]);
    expect(findings[0]?.detail).toContain("has no alt text");
  });

  test("rejects a missing image", () => {
    guide().en += "\n![Screen](absent.png)\n";
    const findings = run();
    expect(rules(findings)).toEqual(["image"]);
    expect(findings[0]?.detail).toContain("does not exist");
  });

  test.each([
    ["a formal imperative", "Rufen Sie die Engine auf."],
    ["a formal possessive", "Prüfe Ihre Einstellungen."],
    ["a formal dative", "Das Cockpit zeigt Ihnen den Lauf."],
    ["a sentence-initial possessive", "Ihr Schlüssel bleibt geheim."],
    ["a wrapped formal pronoun", "Danach können\nSie den Lauf prüfen."],
  ])("rejects %s in a German chapter", (_name, line) => {
    chapters["guide.de.md"] += `\n${line}\n`;
    const findings = run();
    expect(findings.map((f) => [f.rule, f.file])).toEqual([
      ["address", join(paths.referenceDir, "guide.de.md")],
    ]);
  });

  test("rejects formal address in the de bundle", () => {
    guide().de += "\nDanach können Sie den Lauf prüfen.\n";
    const findings = run();
    expect(rules(findings)).toEqual(["address"]);
    expect(findings.every((f) => f.detail.startsWith("guide/de:"))).toBe(true);
  });

  test.each([
    ["a du sentence", "Danach kannst du den Lauf prüfen. Sie bleibt gespeichert."],
    ["a quoted UI string", 'Das Cockpit meldet „Sie sind abgemeldet“ oder "Ihre Sitzung endet".'],
    ["inline code", "Setze `Ihr Wert` oder `Sie` nicht."],
    ["a fenced block", "```\nRufen Sie Ihre API auf.\n```"],
    ["lowercase pronouns", "Die App prüft ihre Sitzung, bevor sie antwortet."],
    ["a list item", "- Sie läuft weiter."],
  ])("accepts %s in a German chapter", (_name, line) => {
    chapters["guide.de.md"] += `\n${line}\n`;
    guide().de += `\n${line}\n`;
    expect(run()).toEqual([]);
  });

  test("rejects an LLMS_PAGE_PATHS mismatch", () => {
    llmsPagePaths = ["guide.md", "cli.md", "settings.md"];
    expect(rules(run())).toEqual(["llms-paths"]);
  });

  test("scans the cockpit bundle", () => {
    run();
    writeFileSync(
      paths.cockpitDocs,
      `export const DOCS: DocsBundle = ${JSON.stringify(
        DocsBundleSchema.parse({
          locales: ["en", "de"],
          sections: DOCS_SECTIONS,
          pages: [
            {
              slug: "guide",
              llms_path: "guide.md",
              audience: "public",
              section: "start",
              order: 1,
              generated: false,
              locales: { en: content("# G\n\n10.1.2.3\n"), de: content("# G\n") },
            },
          ],
        }),
      )};\n`,
    );
    unlinkSync(join(paths.seedDir, "guide.md"));
    const findings = checkDocs(paths, { llmsPagePaths });
    expect(findings.map((f) => [f.rule, f.file])).toEqual([["ip", paths.cockpitDocs]]);
  });

  describe("screenshots", () => {
    test("accepts an EN/DE pair with manifest entries", () => {
      addImage("en");
      addImage("de");
      expect(run()).toEqual([]);
    });

    test("rejects a referenced image whose file is missing", () => {
      const file = addImage("en");
      addImage("de");
      delete imageFiles[file];
      delete manifest[file];
      const details = imageDetails(run());
      expect(details).toEqual([`guide/en: ${servedSrc(file)} does not exist`]);
    });

    test("rejects empty alt text", () => {
      addImage("en", { alt: " " });
      addImage("de");
      expect(imageDetails(run())).toEqual([expect.stringContaining("has no alt text")]);
    });

    test("rejects an image no chapter references", () => {
      addImage("en");
      addImage("de");
      const bytes = webp();
      imageFiles["guide-spare.en.webp"] = bytes;
      manifest["guide-spare.en.webp"] = { sha256: sha(bytes), build: "10.4.0" };
      expect(imageDetails(run())).toEqual(["guide-spare.en.webp is not referenced by any chapter"]);
    });

    test("rejects a name without the chapter slug", () => {
      addImage("en", { name: "other-run" });
      addImage("de", { name: "other-run" });
      const details = imageDetails(run());
      expect(details).toHaveLength(2);
      expect(details.every((d) => d.endsWith("does not start with guide-"))).toBe(true);
    });

    test("rejects a locale suffix that differs from the chapter", () => {
      const file = addImage("de");
      guide().en += `\n![Run result](${servedSrc(file)})\n`;
      const details = imageDetails(run());
      expect(details).toContain(`guide/en: ${servedSrc(file)} does not end with .en.webp`);
    });

    test("rejects a screenshot without its translation", () => {
      addImage("en");
      expect(imageDetails(run())).toEqual(["guide: guide-run has no de image"]);
    });

    test("rejects a stale v", () => {
      const file = addImage("en");
      addImage("de");
      guide().en = guide().en.replace(/\?v=[0-9a-f]{12}/, "?v=000000000000");
      expect(imageDetails(run())).toEqual([
        `guide/en: /docs-images/${file}?v=000000000000 has v=000000000000 but the image is ${sha(imageFiles[file] ?? new Uint8Array()).slice(0, 12)}`,
      ]);
    });

    test.each([
      ["too many bytes", { padding: 250_000 }, "more than 250000"],
      ["too wide", { width: 1601 }, "1601 px wide, more than 1600"],
      ["too high", { height: 2401 }, "2401 px high, more than 2400"],
      ["EXIF", { flags: 0x08 }, "carries EXIF or XMP metadata"],
      ["XMP", { flags: 0x04 }, "carries EXIF or XMP metadata"],
    ])("rejects an image with %s", (_name, spec, detail) => {
      addImage("en", { spec });
      addImage("de");
      expect(imageDetails(run())).toEqual([expect.stringContaining(detail)]);
    });

    test("accepts an image at the limits", () => {
      addImage("en", { spec: { width: 1600, height: 2400, flags: 0x10 } });
      addImage("de");
      expect(run()).toEqual([]);
    });

    test("rejects an image without a manifest entry", () => {
      const file = addImage("en");
      addImage("de");
      delete manifest[file];
      expect(imageDetails(run())).toEqual([`${file} has no manifest entry`]);
    });

    test("rejects a manifest sha that does not match the bytes", () => {
      const file = addImage("en");
      addImage("de");
      manifest[file] = { sha256: "0".repeat(64), build: "10.4.0" };
      expect(imageDetails(run())).toEqual([`${file} sha256 does not match the manifest`]);
    });

    test.each([
      ["a malformed build", "v10", "needs a build like 1.2.3"],
      ["a build newer than the release", "10.5.0", "build 10.5.0 is newer than 10.4.12"],
    ])("rejects %s", (_name, build, detail) => {
      addImage("en", { build });
      addImage("de");
      expect(imageDetails(run())).toEqual([expect.stringContaining(detail)]);
    });

    test("rejects an orphaned manifest entry", () => {
      addImage("en");
      addImage("de");
      manifest["guide-gone.en.webp"] = { sha256: "0".repeat(64), build: "10.4.0" };
      expect(imageDetails(run())).toEqual(["manifest entry guide-gone.en.webp has no image"]);
    });

    test("rejects a file that does not follow the naming rule", () => {
      addImage("en");
      addImage("de");
      imageFiles["Guide Run.png"] = webp();
      expect(imageDetails(run())).toEqual([
        "Guide Run.png is not named <slug>-<name>.<en|de>.webp",
      ]);
    });

    test("rejects a local image that is not served from /docs-images", () => {
      chapters["shot.png"] = "png";
      guide().en += "\n![Screen](shot.png)\n";
      expect(imageDetails(run())).toEqual(["guide/en: shot.png is not served from /docs-images/"]);
    });

    test("still checks raw image hosts", () => {
      guide().en += "\n![Screen](https://images.vendor.io/shot.webp)\n";
      expect(rules(run())).toContain("host");
    });
  });
});

function servedSrc(file: string): string {
  return servedImageSrc(file, sha(imageFiles[file] ?? webp()));
}
