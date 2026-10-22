import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_SECTION_IDS, type DocsSectionId, docsSectionRank } from "@shared/llms-index.ts";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

export interface Chapter {
  slug: string;
  section: DocsSectionId;
  order: number;
  title: string | undefined;
  summary: string | undefined;
  pathChoice: string | undefined;
  audience: string | undefined;
  seed: string | undefined;
  seedVersion: number | undefined;
  body: string;
}

export interface Heading {
  depth: number;
  text: string;
  anchor: string;
}

export interface Image {
  src: string;
  alt: string;
}

export type Locale = "en" | "de";

export function loadChapters(dir: string, locale: Locale = "en"): Chapter[] {
  const chapters: Chapter[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(`.${locale}.md`))) {
    const raw = readFileSync(join(dir, file), "utf8");
    const match = raw.match(FRONTMATTER);
    const head = match?.[1];
    if (!match || head === undefined) throw new Error(`${file} has no frontmatter`);
    const field = (key: string) => head.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1]?.trim();
    const slug = field("slug");
    const rawOrder = field("order");
    if (!slug) throw new Error(`${file} needs slug`);
    const section = field("section");
    if (section === undefined) throw new Error(`${file} needs section`);
    if (!isSection(section)) throw new Error(`${file} has unknown section ${section}`);
    if (rawOrder === undefined || !/^\d+$/.test(rawOrder)) throw new Error(`${file} needs order`);
    if (chapters.some((c) => c.slug === slug)) throw new Error(`duplicate chapter slug ${slug}`);
    const order = Number(rawOrder);
    const clash = chapters.find((c) => c.section === section && c.order === order);
    if (clash) throw new Error(`${slug} and ${clash.slug} share order ${order} in ${section}`);
    const seed = field("seed");
    const rawSeedVersion = field("seed_version");
    if (rawSeedVersion !== undefined && !/^[1-9]\d*$/.test(rawSeedVersion))
      throw new Error(`${file} needs a positive integer seed_version`);
    if (seed && rawSeedVersion === undefined) throw new Error(`${file} needs seed_version`);
    if (!seed && rawSeedVersion !== undefined)
      throw new Error(`${file} has seed_version without seed`);
    const pathChoice = field("path_choice");
    if (pathChoice !== undefined && !/^[a-z][a-z0-9-]*$/.test(pathChoice))
      throw new Error(`${file} needs a lowercase path_choice`);
    if (pathChoice !== undefined && section !== "start")
      throw new Error(`${file} has path_choice outside section start`);
    chapters.push({
      slug,
      section,
      order,
      title: field("title"),
      summary: field("summary"),
      pathChoice,
      audience: field("audience"),
      seed,
      seedVersion: rawSeedVersion === undefined ? undefined : Number(rawSeedVersion),
      body: raw.slice(match[0].length),
    });
  }
  chapters.sort(byReadingPath);
  checkPathChoices(chapters);
  return chapters;
}

function checkPathChoices(chapters: Chapter[]): void {
  const groups = new Set(chapters.flatMap((c) => (c.pathChoice ? [c.pathChoice] : [])));
  for (const group of groups) {
    const positions = chapters.flatMap((c, i) => (c.pathChoice === group ? [i] : []));
    if (positions.length < 2) throw new Error(`path_choice ${group} needs at least two chapters`);
    const first = positions[0] ?? 0;
    if (positions.some((p, i) => p !== first + i))
      throw new Error(`path_choice ${group} chapters must be adjacent`);
  }
}

function isSection(value: string): value is DocsSectionId {
  return (DOCS_SECTION_IDS as readonly string[]).includes(value);
}

export function byReadingPath(
  a: { section: DocsSectionId; order: number; slug: string },
  b: { section: DocsSectionId; order: number; slug: string },
): number {
  return (
    docsSectionRank(a.section) - docsSectionRank(b.section) ||
    a.order - b.order ||
    a.slug.localeCompare(b.slug)
  );
}

export function headings(markdown: string): Heading[] {
  const seen = new Map<string, number>();
  const found: Heading[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const match = fenced ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    const text = match?.[2];
    if (!match || !text) continue;
    const base = text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.push({
      depth: (match[1] ?? "").length,
      text,
      anchor: count === 0 ? base : `${base}-${count}`,
    });
  }
  return found;
}

export function headingAnchors(markdown: string): string[] {
  return headings(markdown).map((h) => h.anchor);
}

export function images(markdown: string): Image[] {
  return [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)].map((m) => ({
    src: m[2] ?? "",
    alt: m[1] ?? "",
  }));
}

export interface WebpInfo {
  width: number;
  height: number;
  metadata: boolean;
}

export const DOCS_IMAGE_NAME = /^[a-z0-9-]+\.(en|de)\.webp$/;

export const DOCS_IMAGE_ROUTE = "/docs-images/";

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function uint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function uint24(bytes: Uint8Array, offset: number): number {
  return uint16(bytes, offset) | ((bytes[offset + 2] ?? 0) << 16);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (uint24(bytes, offset) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

function chunkNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    names.push(fourcc(bytes, offset));
    const size = uint32(bytes, offset + 4);
    offset += 8 + size + (size % 2);
  }
  return names;
}

export function webpInfo(bytes: Uint8Array): WebpInfo | null {
  if (bytes.length < 30 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WEBP") return null;
  const names = chunkNames(bytes);
  const tagged = names.includes("EXIF") || names.includes("XMP ");
  const kind = fourcc(bytes, 12);
  if (kind === "VP8X") {
    const flags = bytes[20] ?? 0;
    return {
      width: uint24(bytes, 24) + 1,
      height: uint24(bytes, 27) + 1,
      metadata: tagged || (flags & 0x0c) !== 0,
    };
  }
  if (kind === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = uint32(bytes, 21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      metadata: tagged,
    };
  }
  if (kind === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      width: uint16(bytes, 26) & 0x3fff,
      height: uint16(bytes, 28) & 0x3fff,
      metadata: tagged,
    };
  }
  return null;
}

export function docsImageFile(src: string): string | null {
  const file = src.match(/^images\/([^/?#]+)$/)?.[1];
  return file && DOCS_IMAGE_NAME.test(file) ? file : null;
}

export function servedImageSrc(file: string, sha: string): string {
  return `${DOCS_IMAGE_ROUTE}${file}?v=${sha.slice(0, 12)}`;
}

export function servedImageFile(src: string): { file: string; version: string | null } | null {
  if (!src.startsWith(DOCS_IMAGE_ROUTE)) return null;
  const rest = src.slice(DOCS_IMAGE_ROUTE.length);
  const query = rest.indexOf("?");
  const file = query < 0 ? rest : rest.slice(0, query);
  const version = query < 0 ? null : new URLSearchParams(rest.slice(query + 1)).get("v");
  return { file, version };
}

export function headingCounts(markdown: string): { h2: number; h3: number } {
  const counts = { h2: 0, h3: 0 };
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^## /.test(line)) counts.h2++;
    else if (/^### /.test(line)) counts.h3++;
  }
  return counts;
}

export function repositoryReferences(markdown: string, shipped: readonly string[]): string {
  return markdown.replace(
    /\[([^\]]+)\]\(((?:\.\.\/|\.\/)?[A-Za-z0-9_./-]+\.md)(#[^)]*)?\)/g,
    (link, _label: string, path: string) => {
      if (shipped.includes(path)) return link;
      throw new Error(`link to ${path} points at a page that is not shipped`);
    },
  );
}

export function stripGeneratedMarker(markdown: string): string {
  return markdown.replace(/^<!--[^\n]*-->\n+/, "").trimEnd();
}

export function chapterTitle(markdown: string, path: string): string {
  const m = markdown.match(/^#{1,2}\s+(.+?)\s*$/m);
  if (!m?.[1]) throw new Error(`${path} has no heading`);
  return m[1];
}

const INLINE_CODE_SPAN = /(`+)([\s\S]*?)\1/g;

const STAR_EMPHASIS = /(\*{1,3})(?=\S)([\s\S]*?\S)\1/g;

const UNDERSCORE_EMPHASIS = /(?<![\p{L}\p{N}_])(_{1,2})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}_])/gu;

function stripEmphasis(text: string): string {
  return text.replace(STAR_EMPHASIS, "$2").replace(UNDERSCORE_EMPHASIS, "$2");
}

function plainText(markdown: string): string {
  let out = "";
  let last = 0;
  for (const match of markdown.matchAll(INLINE_CODE_SPAN)) {
    out += stripEmphasis(markdown.slice(last, match.index)) + (match[2] ?? "").trim();
    last = match.index + match[0].length;
  }
  return out + stripEmphasis(markdown.slice(last));
}

export function summary(markdown: string): string {
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || /^(#|>|\||!\[|```|[-*+]\s|\d+\.\s|<)/.test(text)) continue;
    const plain = plainText(text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")).replace(/\s+/g, " ");
    return (plain.match(/^(.*?[.!?])(?:\s|$)/)?.[1] ?? plain).trim();
  }
  return "";
}
