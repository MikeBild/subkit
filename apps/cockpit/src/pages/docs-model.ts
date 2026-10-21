import { type DocsBundle, docsSectionRank } from "@shared/llms-index";
import type { Locale } from "@/lib/i18n";

export type DocsPage = DocsBundle["pages"][number];
export type DocsSectionId = DocsPage["section"];
export type DocsContent = DocsPage["locales"]["en"];
export type DocsHeading = DocsContent["headings"][number];

export interface DocsRow {
  slug: string;
  section: DocsSectionId;
  step: number;
  choice: string | null;
  title: string;
  summary: string;
  headings: readonly DocsHeading[];
}

export type DocsIndexEntry =
  | { kind: "chapter"; row: DocsRow }
  | { kind: "choice"; id: string; step: number; rows: DocsRow[] };

export interface DocsSectionGroup {
  id: DocsSectionId;
  title: string;
  description: string;
  rows: DocsRow[];
  entries: DocsIndexEntry[];
}

export function pathChoice(page: DocsPage): string | null {
  const value = (page as DocsPage & { path_choice?: unknown }).path_choice;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameChoice(left: DocsPage | undefined, right: DocsPage | undefined): boolean {
  if (!left || !right) return false;
  const choice = pathChoice(left);
  return choice !== null && left.section === right.section && choice === pathChoice(right);
}

export function orderedPages(bundle: DocsBundle): DocsPage[] {
  return [...bundle.pages].sort(
    (left, right) =>
      docsSectionRank(left.section) - docsSectionRank(right.section) ||
      left.order - right.order ||
      left.slug.localeCompare(right.slug),
  );
}

function usable(content: DocsContent | undefined): content is DocsContent {
  return Boolean(content?.title.trim() && content.body.trim());
}

export function localized(page: DocsPage, locale: Locale): DocsContent {
  const wanted = page.locales[locale];
  return usable(wanted) ? wanted : page.locales.en;
}

export function sectionText(
  bundle: DocsBundle,
  id: DocsSectionId,
  locale: Locale,
): { title: string; description: string } | null {
  const section = bundle.sections.find((entry) => entry.id === id);
  if (!section) return null;
  const wanted = section.locales[locale];
  return wanted.title.trim() ? wanted : section.locales.en;
}

export function docsRows(bundle: DocsBundle, locale: Locale): DocsRow[] {
  const steps = new Map<DocsSectionId, number>();
  const pages = orderedPages(bundle);
  return pages.map((page, index) => {
    const content = localized(page, locale);
    const joined = sameChoice(pages[index - 1], page);
    const step = (steps.get(page.section) ?? 0) + (joined ? 0 : 1);
    steps.set(page.section, step);
    return {
      slug: page.slug,
      section: page.section,
      step,
      choice: pathChoice(page),
      title: content.title,
      summary: content.summary,
      headings: content.headings,
    };
  });
}

export function docsSections(
  bundle: DocsBundle,
  locale: Locale,
  rows: readonly DocsRow[],
): DocsSectionGroup[] {
  return [...bundle.sections]
    .sort((left, right) => docsSectionRank(left.id) - docsSectionRank(right.id))
    .map((section) => {
      const text = sectionText(bundle, section.id, locale);
      return {
        id: section.id,
        title: text?.title ?? section.id,
        description: text?.description ?? "",
        rows: rows.filter((row) => row.section === section.id),
      };
    })
    .map((group) => ({ ...group, entries: docsEntries(group.rows) }))
    .filter((section) => section.rows.length > 0);
}

export function docsEntries(rows: readonly DocsRow[]): DocsIndexEntry[] {
  const entries: DocsIndexEntry[] = [];
  for (const row of rows) {
    const last = entries.at(-1);
    if (row.choice && last?.kind === "choice" && last.id === row.choice && last.step === row.step)
      last.rows.push(row);
    else if (row.choice)
      entries.push({ kind: "choice", id: row.choice, step: row.step, rows: [row] });
    else entries.push({ kind: "chapter", row });
  }
  return entries.map((entry) =>
    entry.kind === "choice" && entry.rows.length === 1 && entry.rows[0]
      ? { kind: "chapter", row: entry.rows[0] }
      : entry,
  );
}

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/[`*_]/g, "");
}

export function filterRows(rows: readonly DocsRow[], query: string): DocsRow[] {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = normalized(
      [row.title, row.summary, ...row.headings.map((heading) => heading.text)].join("\n"),
    );
    return terms.every((term) => haystack.includes(term));
  });
}

export interface DocsChoice {
  id: string;
  pages: DocsPage[];
}

export interface DocsNeighbours {
  previous: DocsPage | null;
  next: DocsPage | null;
  choice: DocsChoice | null;
}

function choiceSpan(pages: readonly DocsPage[], index: number): [number, number] {
  let start = index;
  let end = index;
  while (sameChoice(pages[start - 1], pages[index])) start -= 1;
  while (sameChoice(pages[index], pages[end + 1])) end += 1;
  return [start, end];
}

function followingPage(pages: readonly DocsPage[], index: number): DocsPage | null {
  const [start, end] = choiceSpan(pages, index);
  const after = pages[end + 1] ?? null;
  if (start === end || !after) return after;
  const page = pages[index];
  const fits = pages
    .slice(end + 1)
    .find(
      (candidate) =>
        candidate.section === page?.section &&
        (page.audience === "operator" || candidate.audience === "public"),
    );
  return fits ?? after;
}

export function neighbours(bundle: DocsBundle, slug: string): DocsNeighbours {
  const pages = orderedPages(bundle);
  const index = pages.findIndex((page) => page.slug === slug);
  if (index < 0) return { previous: null, next: null, choice: null };
  const [start] = choiceSpan(pages, index);
  const next = followingPage(pages, index);
  const nextIndex = next ? pages.indexOf(next) : -1;
  const [nextStart, nextEnd] = nextIndex < 0 ? [-1, -1] : choiceSpan(pages, nextIndex);
  const choice =
    nextIndex >= 0 && nextEnd > nextStart && next
      ? { id: pathChoice(next) ?? "", pages: pages.slice(nextStart, nextEnd + 1) }
      : null;
  const before = pages[start - 1] ?? null;
  if (!before) return { previous: null, next, choice };
  const beforeIndex = start - 1;
  const [optionsStart, optionsEnd] = choiceSpan(pages, beforeIndex);
  if (optionsEnd === optionsStart) return { previous: before, next, choice };
  const options = pages.slice(optionsStart, optionsEnd + 1);
  const leading = options.find(
    (_, offset) => followingPage(pages, optionsStart + offset)?.slug === slug,
  );
  return { previous: leading ?? before, next, choice };
}

export function findPage(bundle: DocsBundle, slug: string): DocsPage | null {
  return bundle.pages.find((page) => page.slug === slug) ?? null;
}

export function headingSlug(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

export function anchorFor(
  headings: readonly DocsHeading[],
  renderedText: string,
): string | undefined {
  const base = headingSlug(renderedText.trim());
  return headings.find((heading) => heading.anchor === base)?.anchor;
}

export interface DocsArticle {
  title: string;
  summary: string;
  lead: string | null;
  body: string;
  headings: readonly DocsHeading[];
  titleDepth: number;
  toc: DocsHeading[];
}

function withoutTitle(body: string, title: DocsHeading | undefined): string {
  if (!title) return body;
  const lines = body.split("\n");
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match && (match[1] ?? "").length === title.depth && match[2] === title.text) {
      const rest = [...lines.slice(0, index), ...lines.slice(index + 1)];
      while (rest[index] !== undefined && rest[index]?.trim() === "") rest.splice(index, 1);
      return rest.join("\n").replace(/^\n+/, "");
    }
  }
  return body;
}

export function tableOfContents(headings: readonly DocsHeading[]): DocsHeading[] {
  if (headings.length === 0) return [];
  const depths = [...new Set(headings.map((heading) => heading.depth))].sort((a, b) => a - b);
  const first = depths[0] ?? 0;
  const shallow = headings.filter((heading) => heading.depth === first);
  if (shallow.length > 1 || depths.length === 1) return shallow;
  const second = depths[1] ?? first;
  return headings.filter((heading) => heading.depth === first || heading.depth === second);
}

function plain(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function leadOf(summary: string, body: string): string | null {
  const text = plain(summary);
  if (!text) return null;
  return plain(body).includes(text) ? null : summary;
}

export function article(page: DocsPage, locale: Locale): DocsArticle {
  const content = localized(page, locale);
  const [first] = content.headings;
  const title = first && content.headings.every((h) => h.depth >= first.depth) ? first : undefined;
  const sections = title ? content.headings.slice(1) : content.headings;
  const body = withoutTitle(content.body, title);
  return {
    title: content.title,
    summary: content.summary,
    lead: leadOf(content.summary, body),
    body,
    headings: content.headings,
    titleDepth: title?.depth ?? Math.min(...sections.map((h) => h.depth), 2) - 1,
    toc: tableOfContents(sections),
  };
}

export function headingLevel(depth: number, titleDepth: number): 2 | 3 | 4 | 5 | 6 {
  return Math.min(6, Math.max(2, depth - titleDepth + 1)) as 2 | 3 | 4 | 5 | 6;
}

export type DocsLink =
  | { kind: "anchor"; anchor: string }
  | { kind: "chapter"; slug: string; anchor?: string }
  | { kind: "external"; href: string }
  | { kind: "route"; href: string }
  | { kind: "plain"; href: string };

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function chapterWithAnchor(
  pages: readonly DocsPage[],
  locale: Locale,
  anchor: string,
): DocsPage | undefined {
  return pages.find((page) =>
    localized(page, locale).headings.some((heading) => heading.anchor === anchor),
  );
}

export function resolveLink(
  bundle: DocsBundle,
  current: DocsPage,
  locale: Locale,
  href: string,
): DocsLink {
  if (/^(?:https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) return { kind: "external", href };
  const hash = href.indexOf("#");
  const path = hash < 0 ? href : href.slice(0, hash);
  const anchor = hash < 0 ? "" : safeDecode(href.slice(hash + 1));
  const ordered = orderedPages(bundle);
  if (path === "") return anchor ? { kind: "anchor", anchor } : { kind: "plain", href };
  const route = /^\/docs(?:\/([^/?#]+))?\/?$/.exec(path);
  if (route) {
    const slug = route[1] ? safeDecode(route[1]) : null;
    if (!slug) return { kind: "route", href: "/docs" };
    if (!findPage(bundle, slug)) return { kind: "chapter", slug, ...(anchor ? { anchor } : {}) };
    return slug === current.slug && anchor
      ? { kind: "anchor", anchor }
      : { kind: "chapter", slug, ...(anchor ? { anchor } : {}) };
  }
  const name = path.replace(/^(?:\.\.?\/)+/, "").replace(/^llms\//, "");
  if (!/\.md$/.test(name))
    return path.startsWith("/") ? { kind: "route", href } : { kind: "plain", href };
  const sharing = ordered.filter((page) => page.llms_path === name);
  const target = (anchor ? chapterWithAnchor(sharing, locale, anchor) : undefined) ?? sharing[0];
  if (!target) return { kind: "plain", href };
  if (target.slug === current.slug && anchor) return { kind: "anchor", anchor };
  return { kind: "chapter", slug: target.slug, ...(anchor ? { anchor } : {}) };
}

export function releaseVersion(version: string | null | undefined): string | null {
  const value = version?.trim().replace(/^v(?=\d)/, "") ?? "";
  return value ? value : null;
}

export function activeHeading(
  positions: readonly { anchor: string; top: number }[],
  offset: number,
  atBottom: boolean,
  preferred = "",
  viewport = Number.POSITIVE_INFINITY,
): string | undefined {
  if (positions.length === 0) return undefined;
  if (atBottom) {
    const chosen = positions.find((position) => position.anchor === preferred);
    return chosen && chosen.top >= 0 && chosen.top < viewport
      ? chosen.anchor
      : positions.at(-1)?.anchor;
  }
  let current = positions[0]?.anchor;
  for (const position of positions) {
    if (position.top - offset > 0) break;
    current = position.anchor;
  }
  return current;
}
