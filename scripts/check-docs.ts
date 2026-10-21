import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { type DocsBundle, DocsBundleSchema, LLMS_PAGE_PATHS } from "@shared/llms-index.ts";
import { SECRET_PATTERNS } from "@shared/redaction.ts";
import { headingCounts, loadChapters } from "./docs-source.ts";

export interface DocsPaths {
  referenceDir: string;
  llmsDir: string;
  cockpitDocs: string;
  seedDir: string;
  templates: string;
}

export interface CheckOptions {
  llmsPagePaths?: ReadonlyArray<string>;
}

export interface Finding {
  rule:
    | "secret"
    | "ip"
    | "host"
    | "key-file"
    | "local-only"
    | "link"
    | "image"
    | "translation"
    | "address"
    | "llms-paths";
  file: string;
  detail: string;
}

interface Artifact {
  file: string;
  texts: string[];
}

const ROOT = join(import.meta.dir, "..");

export const REPOSITORY_PATHS: DocsPaths = {
  referenceDir: join(ROOT, "apps/engine/src/http/reference"),
  llmsDir: join(ROOT, "apps/engine/src/http/llms"),
  cockpitDocs: join(ROOT, "apps/cockpit/src/app/docs.generated.ts"),
  seedDir: join(ROOT, "apps/engine/src/conversations/seed/knowledge"),
  templates: join(ROOT, "apps/engine/src/connectors/templates.json"),
};

const PUBLIC_PRODUCT_HOSTS = ["subkit.io", "subkit-cloud.mikebild.info", "learn.chatgpt.com"];

const ALLOWED_LOOPBACK = new Set(["127.0.0.1", "::1"]);

const PRIVATE_REPOSITORY_PATH =
  /^\/MikeBild\/subkit\/(?:wiki|issues|projects|milestones)(?:[/?#]|$)/i;

const URL_PATTERN = /\bhttps?:\/\/(?:<[^>\s]*>|[^\s<>`"')\]])+/g;

const PRIVATE_REPOSITORY_REFERENCE =
  /\bgithub\.com\/MikeBild\/subkit\/(?:wiki|issues|projects|milestones)\b/gi;

const PLACEHOLDER_SEGMENT = /\$\{[^}]*\}|\{[^}]*\}|<[^>]*>/g;

const IPV4_CANDIDATE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.]*\d)/g;

const IPV6_CANDIDATE = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;

const INTERNAL_HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local)(?!\.?[\w-])/gi;

const KEY_FILE = /\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\bAuthKey_[A-Z0-9]{10}\.p8\b|\.ssh\/[\w.-]+/g;

const KEY_TEXT_FILE = /(?<![\w.-])[\w.-]+[-_]key\.txt\b/gi;

const LOCAL_ONLY = /(?<![\w.-])\.artifacts\/|\b[A-Z0-9_]*DEMO_URL\b|\bdemo:local\b/g;

const MARKDOWN_LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;

const FENCED_CODE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;

const INLINE_CODE = /(`+)[^`]*?\1/g;

const QUOTED = /„[^“”\n]*[“”]|“[^”\n]*”|"[^"\n]*"|»[^«\n]*«|«[^»\n]*»/g;

const FORMAL_POSSESSIVE =
  /(?<![\p{L}\p{N}_])(?:Ihr|Ihre|Ihnen|Ihren|Ihrem|Ihrer|Ihres)(?![\p{L}\p{N}_])/gu;

const FORMAL_PRONOUN = /(?<![\p{L}\p{N}_])Sie(?![\p{L}\p{N}_])/gu;

const BLOCK_PREFIX = /^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?(?:\|\s*)?[*_([]*$/;

function fresh(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags);
}

function matches(regex: RegExp, text: string): string[] {
  return [...text.matchAll(fresh(regex))].map((m) => m[0]);
}

function readBundle(path: string): DocsBundle {
  return DocsBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function cockpitBundle(path: string): DocsBundle {
  const source = readFileSync(path, "utf8");
  const marker = "DOCS: DocsBundle = ";
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${path} has no DOCS bundle`);
  const json = source
    .slice(start + marker.length)
    .trimEnd()
    .replace(/;$/, "");
  return DocsBundleSchema.parse(JSON.parse(json));
}

function bundleTexts(bundle: DocsBundle): string[] {
  return bundle.pages.flatMap((page) =>
    Object.values(page.locales).flatMap((content) => [
      content.title,
      content.summary,
      content.body,
      ...content.headings.map((h) => h.text),
      ...content.images.flatMap((i) => [i.src, i.alt]),
    ]),
  );
}

function generatedSeeds(dir: string): Artifact[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ file: join(dir, f), text: readFileSync(join(dir, f), "utf8") }))
    .filter(({ text }) => /^---\n[\s\S]*?^generated: true$[\s\S]*?\n---\n/m.test(text))
    .map(({ file, text }) => ({ file, texts: [text] }));
}

function hostRule(host: string): RegExp {
  const pattern = host
    .toLowerCase()
    .split(".")
    .map((label) =>
      /^\{[^}]*\}$/.test(label) ? "[^.]+" : label.replace(/[.*+?^$()|[\]\\-]/g, "\\$&"),
    )
    .join("\\.");
  return new RegExp(`^${pattern}$`);
}

export function vendorHosts(templatesPath: string): RegExp[] {
  const templates = JSON.parse(readFileSync(templatesPath, "utf8")) as Array<{
    base_url?: unknown;
    base_url_options?: unknown;
  }>;
  const urls = templates.flatMap((t) => {
    const options = JSON.stringify(t.base_url_options ?? null);
    return [
      ...(typeof t.base_url === "string" ? [t.base_url] : []),
      ...matches(/https?:\/\/[^\s"\\]+/g, options),
    ];
  });
  const hosts = new Set<string>();
  for (const url of urls) {
    const host = url.match(/^https?:\/\/([^/:?#]+)/)?.[1];
    if (host) hosts.add(host.toLowerCase());
  }
  return [...hosts].sort().map(hostRule);
}

function allowedHost(host: string, path: string, vendors: RegExp[]): boolean {
  if (host === "localhost" || ALLOWED_LOOPBACK.has(host) || host === "[::1]") return true;
  if (host === "example.com" || host.endsWith(".example.com") || host.endsWith(".test"))
    return true;
  if (PUBLIC_PRODUCT_HOSTS.some((p) => host === p || host.endsWith(`.${p}`))) return true;
  if (host === "github.com" || host === "www.github.com")
    return !PRIVATE_REPOSITORY_PATH.test(path);
  return vendors.some((rule) => rule.test(host));
}

function privacyFindings(artifact: Artifact, vendors: RegExp[]): Finding[] {
  const found: Finding[] = [];
  const add = (rule: Finding["rule"], detail: string) => {
    if (!found.some((f) => f.rule === rule && f.detail === detail)) {
      found.push({ rule, file: artifact.file, detail });
    }
  };
  for (const text of artifact.texts) {
    for (const { kind, regex } of SECRET_PATTERNS) {
      for (const hit of matches(regex, text))
        add("secret", `${kind} pattern: ${hit.slice(0, 12)}…`);
    }
    for (const hit of matches(IPV4_CANDIDATE, text)) {
      if (isIP(hit) === 4 && !ALLOWED_LOOPBACK.has(hit)) add("ip", hit);
    }
    for (const hit of matches(IPV6_CANDIDATE, text)) {
      if (isIP(hit) === 6 && !ALLOWED_LOOPBACK.has(hit)) add("ip", hit);
    }
    for (const hit of matches(INTERNAL_HOST, text)) add("host", `internal host ${hit}`);
    for (const hit of matches(KEY_FILE, text)) add("key-file", hit);
    for (const hit of matches(KEY_TEXT_FILE, text)) add("key-file", hit);
    for (const hit of matches(LOCAL_ONLY, text)) add("local-only", hit);
    for (const hit of matches(PRIVATE_REPOSITORY_REFERENCE, text)) add("host", `private ${hit}`);
    for (const raw of matches(URL_PATTERN, text)) {
      const url = raw.replace(/[.,;:!?]+$/, "");
      const literal = url.replace(PLACEHOLDER_SEGMENT, "placeholder");
      let parsed: URL;
      try {
        parsed = new URL(literal);
      } catch {
        add("host", `unparseable URL ${url}`);
        continue;
      }
      const host = parsed.hostname.toLowerCase();
      if (host === "placeholder") continue;
      if (!allowedHost(host, parsed.pathname, vendors)) add("host", `${host} in ${url}`);
    }
  }
  return found;
}

function anchorTarget(
  bundle: DocsBundle,
  locale: "en" | "de",
  link: string,
  current: DocsBundle["pages"],
): string | null {
  const hash = link.indexOf("#");
  const path = hash === -1 ? link : link.slice(0, hash);
  const anchor = hash === -1 ? "" : link.slice(hash + 1);
  const name = path.replace(/^(?:\.\.?\/)+/, "").replace(/^llms\//, "");
  const targets = name === "" ? current : bundle.pages.filter((p) => p.llms_path === name);
  if (targets.length === 0)
    return name === ""
      ? `${link} has no page to resolve against`
      : `${link} points at no published page`;
  if (!anchor) return null;
  const anchors = targets.flatMap((p) => p.locales[locale].headings.map((h) => h.anchor));
  return anchors.includes(decodeURIComponent(anchor))
    ? null
    : `${link} has no matching ${locale} heading`;
}

function isRelativeDocLink(link: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//") || link.startsWith("/"))
    return false;
  return link.startsWith("#") || /\.md(?:#|$)/.test(link);
}

function linkFindings(
  bundle: DocsBundle,
  docsFile: string,
  llmsFull: string,
  llmsFile: string,
): Finding[] {
  const found: Finding[] = [];
  for (const page of bundle.pages) {
    for (const locale of ["en", "de"] as const) {
      for (const m of page.locales[locale].body.matchAll(MARKDOWN_LINK)) {
        const link = m[1] ?? "";
        if (!isRelativeDocLink(link)) continue;
        const problem = anchorTarget(bundle, locale, link, [page]);
        if (problem)
          found.push({
            rule: "link",
            file: docsFile,
            detail: `${page.slug}/${locale}: ${problem}`,
          });
      }
    }
  }
  const sections = llmsFull.split(/\n<!-- Source: (.+?) -->\n/);
  for (let i = 0; i < sections.length; i += 2) {
    const source = i === 0 ? undefined : sections[i - 1];
    const pages = source ? bundle.pages.filter((p) => p.llms_path === source) : [];
    for (const m of (sections[i] ?? "").matchAll(MARKDOWN_LINK)) {
      const link = m[1] ?? "";
      if (!isRelativeDocLink(link)) continue;
      const problem = anchorTarget(bundle, "en", link, pages);
      if (problem) found.push({ rule: "link", file: llmsFile, detail: problem });
    }
  }
  return found;
}

function imageFindings(
  bundle: DocsBundle,
  paths: DocsPaths,
  docsFile: string,
  vendors: RegExp[],
): Finding[] {
  const found: Finding[] = [];
  for (const page of bundle.pages) {
    for (const locale of ["en", "de"] as const) {
      for (const image of page.locales[locale].images) {
        const where = `${page.slug}/${locale}: ${image.src}`;
        if (!image.alt.trim())
          found.push({ rule: "image", file: docsFile, detail: `${where} has no alt text` });
        if (/^https?:\/\//.test(image.src)) {
          const url = new URL(image.src);
          if (!allowedHost(url.hostname.toLowerCase(), url.pathname, vendors)) {
            found.push({ rule: "host", file: docsFile, detail: `image host ${url.hostname}` });
          }
        } else if (!existsSync(join(paths.referenceDir, image.src))) {
          found.push({ rule: "image", file: docsFile, detail: `${where} does not exist` });
        }
      }
    }
  }
  return found;
}

function translationFindings(bundle: DocsBundle, dir: string): Finding[] {
  const found: Finding[] = [];
  const english = loadChapters(dir, "en");
  const german = loadChapters(dir, "de");
  for (const en of english) {
    const de = german.find((c) => c.slug === en.slug);
    if (!de) {
      found.push({ rule: "translation", file: dir, detail: `${en.slug} has no .de.md` });
      continue;
    }
    if (en.section !== de.section || en.order !== de.order) {
      found.push({
        rule: "translation",
        file: dir,
        detail: `${en.slug} is ${en.section}/${en.order} in en but ${de.section}/${de.order} in de`,
      });
    }
    const a = headingCounts(en.body);
    const b = headingCounts(de.body);
    if (a.h2 !== b.h2 || a.h3 !== b.h3) {
      found.push({
        rule: "translation",
        file: dir,
        detail: `${en.slug} has H2/H3 ${a.h2}/${a.h3} in en but ${b.h2}/${b.h3} in de`,
      });
    }
  }
  for (const page of bundle.pages.filter((p) => p.generated)) {
    const intro = german.find((c) => c.slug === page.slug);
    if (!intro?.body.trim()) {
      found.push({
        rule: "translation",
        file: dir,
        detail: `generated ${page.slug} has no DE intro`,
      });
    }
  }
  for (const de of german) {
    const page = bundle.pages.find((p) => p.slug === de.slug);
    if (!english.some((c) => c.slug === de.slug) && !page?.generated) {
      found.push({ rule: "translation", file: dir, detail: `${de.slug}.de.md has no .en.md` });
    }
  }
  return found;
}

export function proseOnly(markdown: string): string {
  return markdown
    .replace(FENCED_CODE, (block) => block.replace(/[^\n]/g, " "))
    .replace(INLINE_CODE, (code) => "x".repeat(code.length))
    .replace(QUOTED, (quote) => "x".repeat(quote.length));
}

function startsSentence(prose: string, index: number): boolean {
  const lineStart = prose.lastIndexOf("\n", index - 1) + 1;
  const prefix = prose.slice(lineStart, index);
  if (/(?:[.!?]|\|)\s*[*_([]*\s*$/.test(prefix)) return true;
  if (!BLOCK_PREFIX.test(prefix)) return false;
  if (/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|\|)/.test(prefix)) return true;
  const previous =
    prose
      .slice(0, Math.max(0, lineStart - 1))
      .split("\n")
      .pop() ?? "";
  if (!previous.trim() || /^\s*(?:#{1,6}\s|\|)/.test(previous)) return true;
  return /[.!?:][*_)\]"“”]*\s*$/.test(previous);
}

export function formalAddress(markdown: string): string[] {
  const prose = proseOnly(markdown);
  const context = (index: number, length: number) =>
    markdown
      .slice(Math.max(0, index - 30), index + length + 30)
      .replace(/\s+/g, " ")
      .trim();
  const hits = [...prose.matchAll(FORMAL_POSSESSIVE)].map((m) => context(m.index, m[0].length));
  for (const m of prose.matchAll(FORMAL_PRONOUN)) {
    if (!startsSentence(prose, m.index)) hits.push(context(m.index, m[0].length));
  }
  return hits;
}

function addressFindings(bundle: DocsBundle, dir: string, docsFile: string): Finding[] {
  const found: Finding[] = [];
  for (const chapter of loadChapters(dir, "de")) {
    for (const hit of formalAddress(chapter.body))
      found.push({
        rule: "address",
        file: join(dir, `${chapter.slug}.de.md`),
        detail: `formal address in "${hit}"`,
      });
  }
  for (const page of bundle.pages) {
    const de = page.locales.de;
    const texts = [de.title, de.summary, de.body, ...de.headings.map((h) => h.text)];
    const hits = new Set(texts.flatMap(formalAddress));
    for (const hit of hits)
      found.push({
        rule: "address",
        file: docsFile,
        detail: `${page.slug}/de: formal address in "${hit}"`,
      });
  }
  return found;
}

function llmsPathFindings(
  bundle: DocsBundle,
  expected: ReadonlyArray<string>,
  docsFile: string,
): Finding[] {
  const actual = bundle.pages.flatMap((p) => (p.llms_path === null ? [] : [p.llms_path]));
  const a = [...new Set(actual)].sort();
  const b = [...new Set(expected)].sort();
  if (expected.length === b.length && a.join("\n") === b.join("\n")) {
    return [];
  }
  return [
    {
      rule: "llms-paths",
      file: docsFile,
      detail: `LLMS_PAGE_PATHS [${b.join(", ")}] differs from docs.json llms_path [${a.join(", ")}]`,
    },
  ];
}

export function checkDocs(paths: DocsPaths, options: CheckOptions = {}): Finding[] {
  const docsFile = join(paths.llmsDir, "docs.json");
  const llmsFile = join(paths.llmsDir, "llms-full.txt");
  const bundle = readBundle(docsFile);
  const llmsFull = readFileSync(llmsFile, "utf8");
  const vendors = vendorHosts(paths.templates);
  const artifacts: Artifact[] = [
    { file: llmsFile, texts: [llmsFull] },
    { file: docsFile, texts: bundleTexts(bundle) },
    { file: paths.cockpitDocs, texts: bundleTexts(cockpitBundle(paths.cockpitDocs)) },
    ...generatedSeeds(paths.seedDir),
  ];
  return [
    ...artifacts.flatMap((a) => privacyFindings(a, vendors)),
    ...linkFindings(bundle, docsFile, llmsFull, llmsFile),
    ...imageFindings(bundle, paths, docsFile, vendors),
    ...translationFindings(bundle, paths.referenceDir),
    ...addressFindings(bundle, paths.referenceDir, docsFile),
    ...llmsPathFindings(bundle, options.llmsPagePaths ?? LLMS_PAGE_PATHS, docsFile),
  ];
}

function main(): void {
  const findings = checkDocs(REPOSITORY_PATHS);
  for (const f of findings)
    console.error(`${f.rule}: ${f.file.replace(`${ROOT}/`, "")}: ${f.detail}`);
  if (findings.length > 0) process.exit(1);
  console.log("docs check passed");
}

if (import.meta.main) main();
