import { describe, expect, test } from "bun:test";
import type { DocsBundle } from "@shared/llms-index";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { DOCS } from "@/app/docs-bundle";
import { pageColumn, pageGutter } from "@/components/cockpit/patterns/page";
import { ReadingScroll, ReadingSkeleton } from "@/components/cockpit/patterns/reading";
import { render, renderInRouter } from "@/components/cockpit/patterns/test-utils";
import { NotFoundPage } from "@/components/failure-state";
import { DocsArticleView, DocsIndexView } from "./docs";
import { article, docsRows, findPage, neighbours, orderedPages } from "./docs-model";

function withHostingChoice(): DocsBundle {
  return {
    ...DOCS,
    pages: DOCS.pages.map((page) =>
      page.slug === "subkit-cloud" || page.slug === "run-the-engine"
        ? ({ ...page, path_choice: "hosting" } as DocsBundle["pages"][number])
        : page,
    ),
  };
}

const VERSION = "1.2.3";

function ids(html: string): string[] {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? "");
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function readingLayouts(html: string): string[] {
  return [...html.matchAll(/data-slot="reading-layout" class="([^"]*)"/g)].map(
    (match) => match[1] ?? "",
  );
}

function withLinks(body: string): DocsBundle {
  const page = DOCS.pages.find((entry) => entry.slug === "web-clipper");
  if (!page) throw new Error("web-clipper chapter is missing");
  const localeWith = (content: (typeof page.locales)["en"]) => ({
    ...content,
    body: `${content.body}\n\n${body}\n`,
  });
  return {
    ...DOCS,
    pages: [
      {
        ...page,
        locales: { en: localeWith(page.locales.en), de: localeWith(page.locales.de) },
      },
    ],
  } as DocsBundle;
}

async function renderAt(
  bundle: DocsBundle,
  path: string,
  locale: "en" | "de" = "de",
): Promise<string> {
  function Chapter() {
    const { slug } = useParams({ strict: false }) as { slug: string };
    return <DocsArticleView bundle={bundle} slug={slug} version="1.2.3" />;
  }
  const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFoundPage });
  const router = createRouter({
    basepath: "/cockpit",
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/docs", component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: "/docs/$slug", component: Chapter }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />, locale);
}

const IMAGE_SRC = "/docs-images/web-clipper-saved-clip.de.webp?v=0123456789ab";

function withImage(build: string | undefined): DocsBundle {
  const page = DOCS.pages.find((entry) => entry.slug === "web-clipper");
  if (!page) throw new Error("web-clipper chapter is missing");
  const image = {
    src: IMAGE_SRC,
    alt: "Gespeicherter Clip im Eingang",
    width: 1280,
    height: 720,
    ...(build ? { build } : {}),
  };
  const withEntry = (content: (typeof page.locales)["en"]) => ({
    ...content,
    body: `## ${content.title}\n\n![Gespeicherter Clip im Eingang](${IMAGE_SRC})\n`,
    images: [image],
  });
  return {
    ...DOCS,
    pages: [
      { ...page, locales: { en: withEntry(page.locales.en), de: withEntry(page.locales.de) } },
    ],
  } as DocsBundle;
}

describe("docs pages", () => {
  test("the index is a learning path followed by the reading sections", async () => {
    const html = await renderInRouter(
      <DocsIndexView bundle={DOCS} version={VERSION} query="" onQuery={() => {}} />,
    );
    expect(html).toContain('data-testid="docs-index"');
    expect(count(html, "<h1 ")).toBe(1);
    expect(html).toContain("Dokumentation");
    expect(html).toContain('data-testid="docs-search"');
    expect(html).not.toContain("docs-area");
    const order = ["start", "work", "operate", "reference"].map((id) =>
      html.indexOf(`data-testid="docs-section-${id}"`),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    for (const title of ["Erste Schritte", "Mit SubKit arbeiten", "Selbst betreiben", "Referenz"])
      expect(html).toContain(title);
    const steps = new Set(
      docsRows(DOCS, "de")
        .filter((row) => row.section === "start")
        .map((row) => row.step),
    ).size;
    expect(count(html, 'data-testid="docs-step"')).toBe(steps);
    expect(html).toMatch(/data-slot="page-purpose"[^>]*>[^<]*<\/p>/);
    expect(html.indexOf("max-w-[780px]")).toBeLessThan(html.indexOf('data-slot="page-purpose"'));
    expect(html).toContain("<ol ");
    for (const page of DOCS.pages)
      expect(count(html, `href="/docs/${page.slug}"`), page.slug).toBe(1);
    expect(count(html, "Stand: SubKit 1.2.3")).toBe(1);
  });

  test("the hosting choice is one learning step with both options side by side", async () => {
    const bundle = withHostingChoice();
    const html = await renderInRouter(
      <DocsIndexView bundle={bundle} version={VERSION} query="" onQuery={() => {}} />,
    );
    expect(count(html, 'data-testid="docs-choice"')).toBe(1);
    expect(html).toContain("Cloud nutzen oder selbst betreiben");
    expect(html).toContain("sm:grid-cols-2");
    const steps = [...html.matchAll(/data-testid="docs-step"[^>]*>(\d+)</g)].map((m) => m[1]);
    expect(steps).toEqual(["1", "2", "3", "4"]);
    const choice = html.slice(html.indexOf('data-testid="docs-choice"'));
    expect(choice.indexOf('href="/docs/subkit-cloud"')).toBeGreaterThan(0);
    expect(choice.indexOf('href="/docs/run-the-engine"')).toBeGreaterThan(0);
    for (const page of bundle.pages)
      expect(count(html, `href="/docs/${page.slug}"`), page.slug).toBe(1);
    const english = await renderInRouter(
      <DocsIndexView bundle={bundle} version={VERSION} query="" onQuery={() => {}} />,
      "en",
    );
    expect(english).toContain("Use the Cloud or self-host");
  });

  test("the intro leads into the hosting choice and each option continues on its own path", async () => {
    const bundle = withHostingChoice();
    const intro = await renderInRouter(
      <DocsArticleView bundle={bundle} slug="intro" version={VERSION} />,
    );
    expect(intro).toContain('data-testid="docs-next"');
    expect(intro).toContain('data-choice="hosting"');
    expect(count(intro, 'data-testid="docs-next-option"')).toBe(2);
    expect(intro).toContain("Cloud nutzen oder selbst betreiben");
    const cloud = await renderInRouter(
      <DocsArticleView bundle={bundle} slug="subkit-cloud" version={VERSION} />,
    );
    expect(cloud).toMatch(
      /data-testid="docs-next"[^>]*href="\/docs\/first-workflow"|href="\/docs\/first-workflow"[^>]*data-testid="docs-next"/,
    );
    expect(cloud).toMatch(
      /href="\/docs\/intro"[^>]*data-testid="docs-previous"|data-testid="docs-previous"[^>]*href="\/docs\/intro"/,
    );
    const engine = await renderInRouter(
      <DocsArticleView bundle={bundle} slug="run-the-engine" version={VERSION} />,
    );
    expect(engine).toMatch(
      /href="\/docs\/first-run-setup"[^>]*data-testid="docs-next"|data-testid="docs-next"[^>]*href="\/docs\/first-run-setup"/,
    );
  });

  test("article tables wrap their cells and scroll only when a table is genuinely wide", async () => {
    const html = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug="web-clipper" version={VERSION} />,
    );
    expect(html).toContain("[&amp;_table]:w-full");
    expect(html).toContain("[&amp;_th]:whitespace-normal");
    expect(html).toContain("[&amp;_td]:[overflow-wrap:break-word]");
    expect(html).not.toContain("[&amp;_table]:w-max");
    expect(html).not.toContain("[&amp;_th]:whitespace-nowrap");
    expect(html).toContain("[&amp;_[data-streamdown=table-container]]:overflow-x-auto");
  });

  test("the article header breathes and the mobile contents start collapsed", async () => {
    const html = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug="web-clipper" version={VERSION} />,
    );
    expect(html).toContain('data-header-rhythm="reading"');
    expect(html).toMatch(
      /data-header-rhythm="reading"[^>]*class="@container flex flex-col pt-10 pb-6"/,
    );
    expect(html).toMatch(/<div class="mb-6"><a[^>]*data-testid="detail-back"/);
    expect(html).toMatch(/data-testid="page-eyebrow" class="[^"]*mb-2/);
    expect(html).toMatch(
      /data-testid="docs-toc"[^>]*data-state="closed"|data-state="closed"[^>]*data-testid="docs-toc"/,
    );
  });

  test("the index search keeps the sections and offers a reset when nothing matches", async () => {
    const clipper = await renderInRouter(
      <DocsIndexView bundle={DOCS} version={VERSION} query="clipper" onQuery={() => {}} />,
      "en",
    );
    expect(clipper).toContain('href="/docs/web-clipper"');
    expect(clipper).toContain('data-testid="docs-section-work"');
    expect(clipper).not.toContain('href="/docs/license"');
    const none = await renderInRouter(
      <DocsIndexView bundle={DOCS} version={VERSION} query="zzzz-nothing" onQuery={() => {}} />,
    );
    expect(none).toContain("Kein Kapitel passt zu deiner Suche");
    expect(none).toContain("Filter zurücksetzen");
    expect(none).not.toContain("docs-section-");
  });

  test("the index waits for the lazy bundle with a skeleton of its sections", async () => {
    const html = await renderInRouter(
      <DocsIndexView bundle={null} pending version={VERSION} query="" onQuery={() => {}} />,
    );
    expect(html).toContain('data-testid="docs-index-loading"');
    expect(html).not.toContain("docs-section-");
  });

  test("an article renders its section, title, body, toc, pager and one release line", async () => {
    const html = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug="web-clipper" version={VERSION} />,
    );
    const page = findPage(DOCS, "web-clipper");
    if (!page) throw new Error("web-clipper chapter is missing");
    const doc = article(page, "de");
    const { previous, next } = neighbours(DOCS, "web-clipper");
    expect(html).toContain('data-testid="docs-article"');
    expect(html).toContain("max-w-[780px]");
    expect(html).toContain('data-testid="detail-back"');
    expect(html).toContain('href="/cockpit/docs"');
    expect(html).toContain('data-testid="page-eyebrow"');
    expect(html).toContain("Mit SubKit arbeiten");
    expect(html).toContain("Auf dieser Seite");
    expect(html).toContain('data-slot="code-block"');
    expect(html).toContain('data-testid="docs-code-copy"');
    expect(count(html, "Stand: SubKit 1.2.3")).toBe(1);
    expect(count(html, "<h1 ")).toBe(1);
    expect(count(html, `>${doc.title}</h`)).toBe(1);
    expect(html).not.toContain("docs-chapters");
    expect(html).toContain('data-testid="docs-previous"');
    expect(html).toContain(`href="/docs/${previous?.slug}"`);
    expect(html).toContain('data-testid="docs-next"');
    expect(html).toContain(`href="/docs/${next?.slug}"`);
    expect(html).toContain("Zurück");
    expect(html).toContain("Weiter");
    for (const heading of doc.toc) {
      expect(html).toContain(`id="${heading.anchor}"`);
      expect(html).toContain(`href="/docs/web-clipper#${heading.anchor}"`);
    }
  });

  test("the first chapter has no previous link and the last no next link", async () => {
    const ordered = orderedPages(DOCS);
    const first = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug={ordered[0]?.slug ?? ""} version={VERSION} />,
    );
    expect(first).not.toContain('data-testid="docs-previous"');
    expect(first).toContain('data-testid="docs-next"');
    const last = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug={ordered.at(-1)?.slug ?? ""} version={VERSION} />,
    );
    expect(last).toContain('data-testid="docs-previous"');
    expect(last).not.toContain('data-testid="docs-next"');
  });

  test("the next link names the section it leads into", async () => {
    const ordered = orderedPages(DOCS);
    const edge = ordered.findIndex(
      (page, index) => ordered[index + 1] && ordered[index + 1]?.section !== page.section,
    );
    const html = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug={ordered[edge]?.slug ?? ""} version={VERSION} />,
    );
    expect(html).toContain("Weiter · Mit SubKit arbeiten");
  });

  test("an English article in English", async () => {
    const html = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug="web-clipper" version={VERSION} />,
      "en",
    );
    expect(html).toContain("On this page");
    expect(count(html, "Applies to SubKit 1.2.3")).toBe(1);
  });

  test("every shipped heading below the title gets its documented anchor as id", async () => {
    for (const page of DOCS.pages) {
      for (const locale of ["en", "de"] as const) {
        const html = await renderInRouter(
          <DocsArticleView bundle={DOCS} slug={page.slug} version={VERSION} />,
          locale,
        );
        const rendered = ids(html);
        const doc = article(page, locale);
        const expected = doc.headings
          .map((heading) => heading.anchor)
          .filter(
            (anchor) =>
              !(doc.headings[0]?.anchor === anchor && doc.titleDepth === doc.headings[0]?.depth),
          );
        for (const anchor of expected)
          expect(rendered, `${page.slug}/${locale} misses ${anchor}`).toContain(anchor);
        const headingIds = rendered.filter((id) => expected.includes(id));
        expect(new Set(headingIds).size, `${page.slug}/${locale}`).toBe(headingIds.length);
      }
    }
  });

  test("external links open in a new tab and say so", async () => {
    const withExternal = DOCS.pages.find((page) => /\]\(https?:\/\//.test(page.locales.en.body));
    if (!withExternal) throw new Error("no chapter links outside");
    const html = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug={withExternal.slug} version={VERSION} />,
      "en",
    );
    expect(html).toContain('data-testid="docs-external-link"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("opens in a new tab");
  });

  test("an unknown chapter is the cockpit's not-found page", async () => {
    const html = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug="missing-chapter" version={VERSION} />,
    );
    expect(html).toContain('data-family-surface="not-found"');
    expect(html).not.toContain('data-testid="docs-article"');
  });

  test("the loading frame mirrors the article column and its toc", async () => {
    const html = await renderInRouter(<ReadingSkeleton />);
    expect(html).toContain('data-family-state="loading"');
    expect(html).toContain('data-family-slot="page-toc"');
    expect(html).toContain("max-w-[780px]");
  });

  test("docs start at the shared left page edge instead of a centered column", async () => {
    const view = await renderInRouter(
      <DocsArticleView bundle={DOCS} slug="web-clipper" version={VERSION} />,
    );
    const skeleton = await renderInRouter(<ReadingSkeleton />);
    const index = await renderInRouter(
      <DocsIndexView bundle={DOCS} version={VERSION} query="" onQuery={() => {}} />,
    );
    const scroll = render(
      <ReadingScroll testId="docs-scroll">
        <span />
      </ReadingScroll>,
    );
    const [layout] = readingLayouts(view);
    expect(layout).toBeDefined();
    expect(readingLayouts(skeleton)).toEqual([layout ?? ""]);
    for (const html of [view, skeleton, index, scroll]) {
      expect(html).not.toContain("mx-auto");
      expect(html).not.toContain("justify-center gap-10");
    }
    expect(scroll).toContain(pageGutter("detail"));
    expect(scroll).toContain(`class="${pageColumn("detail")}"`);
    expect(index).toContain(pageColumn("detail"));
  });

  test("internal documentation links stay inside the cockpit and its base path", async () => {
    const bundle = withLinks(
      "[Index](/docs) [Gone](/docs/nope) [Settings](/settings?tab=x) [Broken](/docs/%E0%A4%A)",
    );
    const html = await renderAt(bundle, "/cockpit/docs/web-clipper");
    expect(html).toContain('href="/cockpit/docs"');
    expect(html).toContain('href="/cockpit/docs/nope"');
    expect(html).toContain('href="/cockpit/settings?tab=x"');
    expect(html).not.toContain('href="/docs"');
    expect(html).not.toContain('href="/settings');
    const missing = await renderAt(bundle, "/cockpit/docs/nope");
    expect(missing).toContain('data-family-surface="not-found"');
    expect(missing).not.toContain('data-testid="docs-article"');
  });

  test("a screenshot renders root-relative and lazy with its alt, size, build caption and full-size link", async () => {
    const html = await renderAt(withImage(VERSION), "/cockpit/docs/web-clipper");
    const image = html.match(/<img [^>]*>/)?.[0] ?? "";
    expect(image).toContain(`src="${IMAGE_SRC}"`);
    expect(image).toContain('alt="Gespeicherter Clip im Eingang"');
    expect(image).toContain('loading="lazy"');
    expect(image).toContain('decoding="async"');
    expect(image).toContain('width="1280"');
    expect(image).toContain('height="720"');
    expect(html).toContain(`<a href="${IMAGE_SRC}" target="_blank" rel="noreferrer"`);
    expect(html).toContain('<span class="sr-only"> (öffnet in einem neuen Tab)</span></a>');
    expect(html).toContain(`Screenshot aus Build ${VERSION}`);
    const english = await renderAt(withImage(VERSION), "/cockpit/docs/web-clipper", "en");
    expect(english).toContain(`Screenshot from build ${VERSION}`);
  });

  test("a screenshot without a recorded build renders no caption", async () => {
    const html = await renderAt(withImage(undefined), "/cockpit/docs/web-clipper");
    expect(html).toContain('data-testid="docs-image"');
    expect(html).not.toContain("Screenshot aus Build");
  });
});
