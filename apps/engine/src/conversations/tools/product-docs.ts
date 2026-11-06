import { DocsBundleSchema } from "@shared/llms-index.ts";
import docsJson from "../../http/llms/docs.json" with { type: "text" };

type ProductDocLocale = "en" | "de";

interface ProductDocHit {
  id: string;
  source: "product_docs";
  slug: string;
  locale: ProductDocLocale;
  title: string;
  heading: string;
  anchor: string | null;
  path: string;
  sha256: string;
  snippet: string;
  score: number;
}

interface ProductDocSection {
  slug: string;
  locale: ProductDocLocale;
  title: string;
  heading: string;
  anchor: string | null;
  sha256: string;
  text: string;
  titleTokens: Set<string>;
  headingTokens: Set<string>;
  bodyTokens: Map<string, number>;
  bodyLength: number;
}

const SNIPPET_LENGTH = 400;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9ß]+/)
    .filter((t) => t.length > 1);
}

function stem(token: string): string {
  return token.length > 5 ? token.slice(0, 5) : token;
}

function stems(text: string): string[] {
  return tokenize(text).map(stem);
}

function splitSections(body: string): Array<{ heading: string | null; text: string }> {
  const out: Array<{ heading: string | null; text: string }> = [];
  let heading: string | null = null;
  let lines: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text || heading) out.push({ heading, text });
  };
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const match = inFence ? null : /^(#{2,3})\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = (match[2] ?? "").trim();
      lines = [];
      continue;
    }
    lines.push(line);
  }
  flush();
  return out;
}

function buildIndex(): ProductDocSection[] {
  const bundle = DocsBundleSchema.parse(JSON.parse(String(docsJson)));
  const sections: ProductDocSection[] = [];
  for (const page of bundle.pages) {
    for (const locale of bundle.locales) {
      const content = page.locales[locale];
      const anchors = new Map(content.headings.map((h) => [h.text, h.anchor]));
      for (const part of splitSections(content.body)) {
        const heading = part.heading ?? content.title;
        const bodyTokens = new Map<string, number>();
        const bodyStems = stems(part.text);
        for (const t of bodyStems) bodyTokens.set(t, (bodyTokens.get(t) ?? 0) + 1);
        sections.push({
          slug: page.slug,
          locale,
          title: content.title,
          heading,
          anchor: part.heading ? (anchors.get(part.heading) ?? null) : null,
          sha256: content.sha256,
          text: part.text,
          titleTokens: new Set(stems(`${content.title} ${page.slug.replaceAll("-", " ")}`)),
          headingTokens: new Set(heading === content.title ? [] : stems(heading)),
          bodyTokens,
          bodyLength: bodyStems.length,
        });
      }
    }
  }
  return sections;
}

let index: ProductDocSection[] | null = null;

function sectionsIndex(): ProductDocSection[] {
  index ??= buildIndex();
  return index;
}

function sectionId(section: ProductDocSection): string {
  return `product-docs:${section.locale}:${section.slug}${section.anchor ? `#${section.anchor}` : ""}`;
}

let sectionIds: Set<string> | null = null;

export function isProductDocId(id: string): boolean {
  sectionIds ??= new Set(sectionsIndex().map(sectionId));
  return sectionIds.has(id);
}

function scoreSection(section: ProductDocSection, queryStems: string[]): number {
  let score = 0;
  let matched = 0;
  for (const q of queryStems) {
    const inTitle = section.titleTokens.has(q);
    const inHeading = section.headingTokens.has(q);
    const count = section.bodyTokens.get(q) ?? 0;
    if (inTitle || inHeading || count > 0) matched += 1;
    if (inTitle) score += 3;
    if (inHeading) score += 4;
    if (count > 0) score += (1 + Math.log(count)) / Math.log(2 + section.bodyLength / 50);
  }
  if (matched === 0) return 0;
  return score * (matched / queryStems.length);
}

export function searchProductDocs(input: {
  query: string;
  limit: number;
  locale?: ProductDocLocale;
}): ProductDocHit[] {
  const queryStems = [...new Set(stems(input.query))];
  if (queryStems.length === 0) return [];
  const ranked = sectionsIndex()
    .filter((s) => !input.locale || s.locale === input.locale)
    .map((s) => ({ section: s, score: scoreSection(s, queryStems) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, input.limit).map(({ section, score }) => ({
    id: sectionId(section),
    source: "product_docs",
    slug: section.slug,
    locale: section.locale,
    title: section.title,
    heading: section.heading,
    anchor: section.anchor,
    path: `/docs.json#${section.slug}`,
    sha256: section.sha256,
    snippet: section.text.slice(0, SNIPPET_LENGTH),
    score: Number(score.toFixed(4)),
  }));
}
