import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DOCS_SECTIONS,
  type DocsBundle,
  DocsBundleSchema,
  LLMS_PAGE_PATHS,
  type LlmsPage,
  renderLlmsIndex,
} from "@shared/llms-index.ts";
import {
  byReadingPath,
  type Chapter,
  chapterTitle,
  DOCS_IMAGE_NAME,
  docsImageFile,
  headings,
  images as imagesOf,
  loadChapters,
  repositoryReferences,
  servedImageFile,
  servedImageSrc,
  stripGeneratedMarker,
  summary,
  webpInfo,
} from "./docs-source.ts";

const OUT_DIR = "apps/engine/src/http/llms";

const REFERENCE_DIR = "apps/engine/src/http/reference";

const SEED_DIR = "apps/engine/src/conversations/seed/knowledge";

const EMBEDDED_SEEDS = "apps/engine/src/knowledge/embedded-seeds.ts";

const IMAGES_DIR = join(REFERENCE_DIR, "images");

const DOCS_IMAGES_MODULE = "apps/engine/src/http/docs-images-embedded.ts";

export interface ImageManifestEntry {
  sha256: string;
  build: string;
}

export interface DocsImageEntry {
  file: string;
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  build?: string;
}

export type DocsImages = ReadonlyMap<string, DocsImageEntry>;

export function loadImageManifest(dir: string): Record<string, ImageManifestEntry> {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, ImageManifestEntry>;
}

export function loadDocsImages(dir: string): DocsImages {
  const found = new Map<string, DocsImageEntry>();
  if (!existsSync(dir)) return found;
  const manifest = loadImageManifest(dir);
  for (const file of readdirSync(dir)
    .filter((f) => DOCS_IMAGE_NAME.test(f))
    .sort()) {
    const bytes = new Uint8Array(readFileSync(join(dir, file)));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const info = webpInfo(bytes);
    const recorded = manifest[file];
    found.set(file, {
      file,
      sha256: sha,
      bytes: bytes.length,
      ...(info ? { width: info.width, height: info.height } : {}),
      ...(recorded?.sha256 === sha && recorded.build ? { build: recorded.build } : {}),
    });
  }
  return found;
}

export function rewriteImages(body: string, images: DocsImages): string {
  return body.replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (whole, head: string, src: string) => {
    const file = docsImageFile(src);
    const image = file ? images.get(file) : undefined;
    return image ? `${head}${servedImageSrc(image.file, image.sha256)}` : whole;
  });
}

export function imageEntries(body: string, images: DocsImages) {
  return imagesOf(body).map((image) => {
    const served = servedImageFile(image.src);
    const entry = served ? images.get(served.file) : undefined;
    if (!entry) return image;
    return {
      ...image,
      ...(entry.build ? { build: entry.build } : {}),
      ...(entry.width ? { width: entry.width } : {}),
      ...(entry.height ? { height: entry.height } : {}),
    };
  });
}

function imageIdentifier(file: string, index: number): string {
  const words = file
    .replace(/\.webp$/, "")
    .split(/[-.]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `image${index}${words}`;
}

function imageImport(file: string, identifier: string): string {
  const head = `import ${identifier} from "./reference/images/${file}" with `;
  const single = `${head}{ type: "file" };`;
  return single.length <= 100 ? single : `${head}{\n  type: "file",\n};`;
}

export function renderDocsImages(entries: readonly DocsImageEntry[]): string {
  const sorted = [...entries]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((entry, index) => ({ ...entry, identifier: imageIdentifier(entry.file, index) }));
  const record =
    sorted.length === 0
      ? ["export const DOCS_IMAGES: Readonly<Record<string, EmbeddedDocsImage>> = {};"]
      : [
          "export const DOCS_IMAGES: Readonly<Record<string, EmbeddedDocsImage>> = {",
          ...sorted.flatMap((entry) => [
            `  "${entry.file}": {`,
            `    path: ${entry.identifier},`,
            `    sha256: "${entry.sha256}",`,
            `    bytes: ${entry.bytes},`,
            "  },",
          ]),
          "};",
        ];
  return [
    ...sorted.map((entry) => imageImport(entry.file, entry.identifier)),
    ...(sorted.length === 0 ? [] : [""]),
    "export interface EmbeddedDocsImage {",
    "  path: string;",
    "  sha256: string;",
    "  bytes: number;",
    "}",
    "",
    ...record,
    "",
  ].join("\n");
}

let cachedImages: DocsImages | undefined;

function docsImages(): DocsImages {
  cachedImages ??= loadDocsImages(IMAGES_DIR);
  return cachedImages;
}

function referencedImages(bundle: DocsBundle, images: DocsImages): DocsImageEntry[] {
  const files = new Set(
    bundle.pages.flatMap((page) =>
      Object.values(page.locales).flatMap((content) =>
        content.images.flatMap((image) => {
          const file = servedImageFile(image.src)?.file;
          return file ? [file] : [];
        }),
      ),
    ),
  );
  return [...images.values()].filter((entry) => files.has(entry.file));
}

interface SeedEntry {
  file: string;
  name: string;
  description: string;
  tags: readonly string[];
}

const SEEDS: Record<string, SeedEntry> = {
  "sk-ref-coding-agents": {
    file: "coding-agents.md",
    name: "sk Platform Reference — Coding Agents",
    description:
      "How a person connects Claude Code, Codex, Hermes or another MCP client to sk, what the session briefing is and how knowledge reaches it, how an agent runs workflows and looks things up under the person's own rights, how learnings flow back, and what to check when a briefing does not arrive.",
    tags: [
      "sk-platform-reference",
      "coding-agents",
      "claude-code",
      "codex",
      "hermes",
      "mcp",
      "hooks",
      "briefing",
      "onboarding",
    ],
  },
};

function isGeneratedSeed(path: string): boolean {
  const head = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  return head !== undefined && /^generated: true$/m.test(head);
}

function seedVersion(path: string): number | undefined {
  const head = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  const raw = head?.match(/^version: (\d+)$/m)?.[1];
  return raw === undefined ? undefined : Number(raw);
}

function renderSeed(slug: string, entry: SeedEntry, version: number, body: string): string {
  return [
    "---",
    `slug: ${slug}`,
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `tags: [${entry.tags.join(", ")}]`,
    "scope: global",
    `version: ${version}`,
    "generated: true",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function seedIdentifier(file: string): string {
  return file.replace(/\.md$/, "").replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function seedImport(file: string): string {
  const head = `import ${seedIdentifier(file)} from "../conversations/seed/knowledge/${file}" with `;
  const single = `${head}{ type: "text" };`;
  return single.length <= 100 ? single : `${head}{\n  type: "text",\n};`;
}

function renderEmbeddedSeeds(files: readonly string[]): string {
  return [
    ...files.map(seedImport),
    "",
    "export interface EmbeddedKnowledgeSeedFile {",
    "  file: string;",
    "  content: string;",
    "}",
    "",
    "export const EMBEDDED_KNOWLEDGE_SEEDS: readonly EmbeddedKnowledgeSeedFile[] = [",
    ...files.map((file) => `  { file: "${file}", content: ${seedIdentifier(file)} },`),
    "];",
    "",
  ].join("\n");
}

function writeSeeds(): void {
  const written = new Set<string>();
  for (const chapter of loadChapters(REFERENCE_DIR, "en")) {
    if (!chapter.seed) continue;
    const entry = SEEDS[chapter.seed];
    if (!entry) throw new Error(`${chapter.slug} names unknown seed ${chapter.seed}`);
    const path = join(SEED_DIR, entry.file);
    if (existsSync(path) && !isGeneratedSeed(path)) {
      throw new Error(`${path} is hand-authored; seed ${chapter.seed} would overwrite it`);
    }
    const version = chapter.seedVersion;
    if (version === undefined) throw new Error(`${chapter.slug} needs seed_version`);
    const previous = existsSync(path) ? seedVersion(path) : undefined;
    if (previous !== undefined && version < previous) {
      throw new Error(
        `${chapter.slug} seed_version ${version} is below the shipped version ${previous}`,
      );
    }
    writeFileSync(path, renderSeed(chapter.seed, entry, version, technicalReference(chapter.slug)));
    written.add(entry.file);
  }
  for (const [slug, entry] of Object.entries(SEEDS)) {
    if (!written.has(entry.file)) throw new Error(`seed ${slug} has no chapter`);
  }
  const files = readdirSync(SEED_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  for (const file of files) {
    if (!written.has(file) && isGeneratedSeed(join(SEED_DIR, file))) {
      unlinkSync(join(SEED_DIR, file));
    }
  }
  writeFileSync(
    EMBEDDED_SEEDS,
    renderEmbeddedSeeds(files.filter((f) => existsSync(join(SEED_DIR, f)))),
  );
}

function references(markdown: string): string {
  return rewriteImages(repositoryReferences(markdown, LLMS_PAGE_PATHS), docsImages());
}

function technicalReference(slug: string): string {
  const chapter = loadChapters(REFERENCE_DIR).find((c) => c.slug === slug);
  if (!chapter) throw new Error(`technical setup reference has no ${slug} chapter`);
  return references(chapter.body.replace(/^## /, "# ").trimEnd());
}

const SETUP_PATH = "setup.md";

const SOURCES: Record<string, () => string> = {
  [SETUP_PATH]: () =>
    references(
      loadChapters(REFERENCE_DIR)
        .map((c) => c.body)
        .join(""),
    ),
  "coding-agents.md": () => technicalReference("use-sk-from-a-coding-agent"),
  "transactional-email.md": () => technicalReference("transactional-email-replies"),
  "cli.md": () => run("scripts/gen-cli-reference.ts"),
  "settings.md": () => run("apps/engine/scripts/gen-settings-doc.ts"),
  "connectors.md": () => run("scripts/gen-catalog.ts"),
};

function run(script: string): string {
  const res = Bun.spawnSync(["bun", "run", script], { stdout: "pipe", stderr: "inherit" });
  if (res.exitCode !== 0) throw new Error(`${script} exited with ${res.exitCode}`);
  return res.stdout.toString();
}

const OWN_LLMS_PATH_BY_SLUG: Record<string, string> = {
  "use-sk-from-a-coding-agent": "coding-agents.md",
  "transactional-email-replies": "transactional-email.md",
  cli: "cli.md",
  settings: "settings.md",
  connectors: "connectors.md",
};

const GENERATED_SLUGS = ["cli", "settings", "connectors"] as const;

type Locale = "en" | "de";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function localeContent(raw: string, slug: string, title: string | undefined, lead: string) {
  const body = rewriteImages(raw, docsImages());
  return {
    title: title ?? chapterTitle(body, slug),
    summary: lead,
    headings: headings(body),
    images: imageEntries(body, docsImages()),
    sha256: sha256(body),
    body,
  };
}

function requireChapter(chapters: Chapter[], slug: string, locale: Locale): Chapter {
  const chapter = chapters.find((c) => c.slug === slug);
  if (!chapter) throw new Error(`${slug} has no ${locale} chapter`);
  return chapter;
}

function chapterSummary(chapter: Chapter, locale: Locale): string {
  if (!chapter.summary) throw new Error(`${chapter.slug}.${locale}.md needs summary`);
  return chapter.summary;
}

function pageAudience(chapter: Chapter): "public" | "operator" {
  if (chapter.audience !== "public" && chapter.audience !== "operator") {
    throw new Error(`${chapter.slug} needs audience public or operator`);
  }
  return chapter.audience;
}

function llmsPath(slug: string, generated: boolean): string {
  const own = OWN_LLMS_PATH_BY_SLUG[slug];
  if (own) return own;
  if (generated) throw new Error(`generated ${slug} has no llms page`);
  return SETUP_PATH;
}

function samePathChoice(en: Chapter, de: Chapter): string | undefined {
  if (en.pathChoice !== de.pathChoice)
    throw new Error(`${en.slug} has different path_choice in en and de`);
  return en.pathChoice;
}

function buildBundle(generated: Record<string, string>): DocsBundle {
  const english = loadChapters(REFERENCE_DIR, "en");
  const german = loadChapters(REFERENCE_DIR, "de");
  const authored = english.map((en) => {
    const de = requireChapter(german, en.slug, "de");
    return {
      slug: en.slug,
      section: en.section,
      order: en.order,
      audience: pageAudience(en),
      generated: false,
      en: en.body.trimEnd(),
      de: de.body.trimEnd(),
      enTitle: en.title,
      deTitle: de.title,
      enSummary: chapterSummary(en, "en"),
      deSummary: chapterSummary(de, "de"),
      pathChoice: samePathChoice(en, de),
    };
  });
  const derived = GENERATED_SLUGS.map((slug) => {
    const intro = requireChapter(german, slug, "de");
    const body = generated[slug] ?? "";
    if (!intro.title) throw new Error(`${slug}.de.md needs a German title`);
    return {
      slug,
      section: intro.section,
      order: intro.order,
      audience: pageAudience(intro),
      generated: true,
      en: body,
      de: `${intro.body.trimEnd()}\n\n${body}`,
      enTitle: undefined,
      deTitle: intro.title,
      enSummary: summary(body),
      deSummary: chapterSummary(intro, "de"),
      pathChoice: intro.pathChoice,
    };
  });
  const pages = [...authored, ...derived].sort(byReadingPath).map((p) => ({
    slug: p.slug,
    llms_path: llmsPath(p.slug, p.generated),
    audience: p.audience,
    section: p.section,
    order: p.order,
    generated: p.generated,
    ...(p.pathChoice ? { path_choice: p.pathChoice } : {}),
    locales: {
      en: localeContent(p.en, p.slug, p.enTitle, p.enSummary),
      de: localeContent(p.de, p.slug, p.deTitle, p.deSummary),
    },
  }));
  return DocsBundleSchema.parse({ locales: ["en", "de"], sections: DOCS_SECTIONS, pages });
}

function main(): void {
  const generated: Record<string, string> = {};
  for (const slug of GENERATED_SLUGS) {
    const source = SOURCES[`${slug}.md`];
    if (!source) throw new Error(`no source for ${slug}.md`);
    generated[slug] = stripGeneratedMarker(source());
  }
  const sources: Record<string, () => string> = {
    ...SOURCES,
    ...Object.fromEntries(
      GENERATED_SLUGS.map((slug) => [`${slug}.md`, () => generated[slug] ?? ""]),
    ),
  };

  const pages: Array<LlmsPage & { body: string }> = LLMS_PAGE_PATHS.map((path) => {
    const source = sources[path];
    if (!source) throw new Error(`no source for ${path}`);
    const body = stripGeneratedMarker(source());
    return { path, title: chapterTitle(body, path), summary: summary(body), body };
  });

  const full = [
    renderLlmsIndex(pages, { linkFor: (p) => `llms/${p.path}`, fullUrl: "llms-full.txt" }),
    ...pages.map((p) => `\n<!-- Source: ${p.path} -->\n\n${p.body}`),
  ].join("\n");

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "llms-full.txt"), `${full}\n`);
  const docsBundle = buildBundle(generated);
  const bundle = JSON.stringify(docsBundle, null, 2);
  writeFileSync(join(OUT_DIR, "docs.json"), `${bundle}\n`);
  writeFileSync(DOCS_IMAGES_MODULE, renderDocsImages(referencedImages(docsBundle, docsImages())));
  const format = Bun.spawnSync(
    [process.execPath, "x", "biome", "check", "--write", DOCS_IMAGES_MODULE],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (format.exitCode !== 0) throw new Error(`biome could not format ${DOCS_IMAGES_MODULE}`);
  writeSeeds();
}

if (import.meta.main) main();
