import type { DocsBundle } from "@shared/llms-index";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { Skeleton } from "@ui/atoms/skeleton";
import { cn } from "@ui/lib/utils";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { FilterBar } from "@ui/organisms/filter-bar";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import {
  type ComponentProps,
  type JSX,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultRemarkPlugins } from "streamdown";
import { routerTarget } from "@/app/links";
import { useSession } from "@/app/session";
import { MessageResponse } from "@/components/ai-elements/message";
import { renderAction, useErrorNotice } from "@/components/cockpit/patterns";
import { ActionButton } from "@/components/cockpit/patterns/action-button";
import { CodeBlock } from "@/components/cockpit/patterns/code-block";
import { Page } from "@/components/cockpit/patterns/page";
import { PageHeader } from "@/components/cockpit/patterns/page-header";
import {
  CollapsibleCard,
  READING_MEASURE,
  ReadingCompanion,
  ReadingLayout,
  ReadingScroll,
  ReadingSkeleton,
} from "@/components/cockpit/patterns/reading";
import { Loadable } from "@/components/cockpit/patterns/skeleton";
import { NotFoundPage } from "@/components/failure-state";
import { AuditMeta, PageSection, StatePanel } from "@/components/ui-states";
import {
  activeHeading,
  anchorFor,
  article,
  chapterLinks,
  type DocsArticle,
  type DocsChoice,
  type DocsHeading,
  type DocsIndexEntry,
  type DocsPage,
  type DocsRow,
  type DocsSectionGroup,
  docsRows,
  docsSections,
  filterRows,
  findPage,
  headingLevel,
  imageFor,
  localized,
  neighbours,
  releaseVersion,
  resolveLink,
  safeDecode,
  sectionText,
  spyMode,
} from "@/features/documentation";
import type { Locale, TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

const DOCS_QUERY_KEY = ["docs-bundle"] as const;

function useDocsBundle() {
  return useQuery({
    queryKey: DOCS_QUERY_KEY,
    queryFn: async (): Promise<DocsBundle> => (await import("@/app/docs-bundle")).DOCS,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

function LoadFailed({ onRetry, error }: { onRetry?: () => void; error?: unknown }) {
  const { t } = useI18n();
  const notice = useErrorNotice({
    error: error ?? undefined,
    body: t("resource.loadFailedDescription"),
  });
  return (
    <ErrorNotice
      {...notice}
      title={t("docs.loadFailed")}
      actions={
        onRetry
          ? renderAction({
              label: t("pattern.retry"),
              variant: "primary",
              size: "sm",
              onClick: onRetry,
              testId: "docs-load-retry",
            })
          : undefined
      }
      testId="docs-load-failed"
    />
  );
}

const ENGINE_INDEX_HREF = "/engine";

function ReleaseLine({ version }: { version: string | null }) {
  const { t } = useI18n();
  return (
    <AuditMeta
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-4 text-xs leading-4"
      data-testid="docs-release"
    >
      {version ? <span>{t("docs.release", { version })}</span> : null}
      <a
        href={ENGINE_INDEX_HREF}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-4 hover:text-foreground"
        data-testid="docs-engine-index"
      >
        {t("docs.engineIndex")}
        <ExternalLink aria-hidden="true" className="ml-0.5 inline size-3 align-[-2px]" />
        <span className="sr-only"> ({t("docs.external")})</span>
      </a>
    </AuditMeta>
  );
}

function searchValue(search: unknown, key: string): string {
  const value = (search as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

export function DocsIndexPage() {
  const session = useSession();
  const docs = useDocsBundle();
  const navigate = useNavigate();
  const search = useRouterState({ select: (state) => state.location.search });
  return (
    <DocsIndexView
      bundle={docs.data ?? null}
      pending={docs.isPending}
      failed={docs.isError}
      onRetry={() => void docs.refetch()}
      version={session.version}
      query={searchValue(search, "q")}
      onQuery={(query) =>
        void navigate({ to: "/docs", search: query ? { q: query } : {}, replace: true })
      }
    />
  );
}

const ENTRY_CLASS =
  "group -mx-3 flex min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const STEP_CLASS =
  "flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-medium tabular-nums text-muted-foreground transition-colors";

const OPTION_CLASS =
  "flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const CHOICE_TITLES: Partial<Record<string, TranslationKey>> = {
  hosting: "docs.choice.hosting",
};

function useChoiceTitle(): (id: string, titles: readonly string[]) => string {
  const { t } = useI18n();
  return (id, titles) => {
    const key = CHOICE_TITLES[id];
    return key ? t(key) : titles.join(" / ");
  };
}

function DocsChoiceEntry({ entry }: { entry: Extract<DocsIndexEntry, { kind: "choice" }> }) {
  const choiceTitle = useChoiceTitle();
  return (
    <div
      data-testid="docs-choice"
      data-choice={entry.id}
      className="-mx-3 flex min-w-0 items-start gap-3 px-3 py-2.5"
    >
      <span aria-hidden="true" data-testid="docs-step" className={STEP_CLASS}>
        {entry.step}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <span className="text-sm font-medium leading-5 [overflow-wrap:anywhere]">
          {choiceTitle(
            entry.id,
            entry.rows.map((row) => row.title),
          )}
        </span>
        <ul className="grid gap-2 sm:grid-cols-2">
          {entry.rows.map((row) => (
            <li key={row.slug} className="flex min-w-0">
              <Link
                to="/docs/$slug"
                params={{ slug: row.slug }}
                data-testid="docs-entry"
                className={cn(OPTION_CLASS, "flex-1")}
              >
                <span className="text-sm font-medium leading-5 [overflow-wrap:anywhere]">
                  {row.title}
                </span>
                <span className="line-clamp-2 text-sm leading-5 text-muted-foreground">
                  {row.summary}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DocsEntry({ row, numbered }: { row: DocsRow; numbered: boolean }) {
  return (
    <Link
      to="/docs/$slug"
      params={{ slug: row.slug }}
      data-testid="docs-entry"
      className={ENTRY_CLASS}
    >
      {numbered ? (
        <span
          aria-hidden="true"
          data-testid="docs-step"
          className={cn(STEP_CLASS, "group-hover:border-foreground/40 group-hover:text-foreground")}
        >
          {row.step}
        </span>
      ) : null}
      <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", numbered && "pt-0.5")}>
        <span className="text-sm font-medium leading-5 [overflow-wrap:anywhere]">{row.title}</span>
        <span className="truncate text-sm leading-5 text-muted-foreground">{row.summary}</span>
      </span>
    </Link>
  );
}

function DocsSection({ group }: { group: DocsSectionGroup }) {
  const numbered = group.id === "start";
  const List = numbered ? "ol" : "ul";
  return (
    <PageSection
      slot="docs-section"
      data-testid={`docs-section-${group.id}`}
      title={group.title}
      description={group.description}
    >
      <List className="flex flex-col">
        {group.entries.map((entry) =>
          entry.kind === "choice" ? (
            <li key={`choice:${entry.id}:${entry.step}`}>
              <DocsChoiceEntry entry={entry} />
            </li>
          ) : (
            <li key={entry.row.slug}>
              <DocsEntry row={entry.row} numbered={numbered} />
            </li>
          ),
        )}
      </List>
    </PageSection>
  );
}

function DocsIndexSkeleton() {
  return (
    <div className="flex flex-col gap-10" data-sk-state="loading" data-testid="docs-index-loading">
      {[5, 4, 3].map((count, section) => (
        <div key={section} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-4/5" />
          {Array.from({ length: count }, (_, index) => (
            <div key={index} className="flex items-start gap-3 py-2.5">
              {section === 0 ? <Skeleton className="size-6 rounded-full" /> : null}
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function DocsIndexView({
  bundle,
  pending = false,
  failed = false,
  onRetry,
  version,
  query,
  onQuery,
}: {
  bundle: DocsBundle | null;
  pending?: boolean;
  failed?: boolean;
  onRetry?(): void;
  version: string | null | undefined;
  query: string;
  onQuery(query: string): void;
}) {
  const { t, locale } = useI18n();
  const rows = useMemo(() => (bundle ? docsRows(bundle, locale) : []), [bundle, locale]);
  const groups = useMemo(
    () => (bundle ? docsSections(bundle, locale, filterRows(rows, query)) : []),
    [bundle, locale, rows, query],
  );
  let body: ReactNode;
  if (failed) body = <LoadFailed onRetry={onRetry} />;
  else if (pending || !bundle) body = <DocsIndexSkeleton />;
  else if (rows.length === 0)
    body = <StatePanel state="empty" title={t("docs.empty")} data-testid="docs-empty" />;
  else if (groups.length === 0)
    body = (
      <StatePanel
        state="empty"
        title={t("docs.noMatches")}
        description={t("resource.broaderSearch")}
        data-testid="docs-no-matches"
        action={
          <ActionButton size="sm" onClick={() => onQuery("")} testId="docs-reset">
            {t("catalog.clearFilters")}
          </ActionButton>
        }
      />
    );
  else body = groups.map((group) => <DocsSection key={group.id} group={group} />);
  return (
    <Page
      kind="detail"
      scroll="page"
      surface="collection"
      testId="docs-index"
      header={
        <div className={READING_MEASURE}>
          <PageHeader title={t("docs.title")} purpose={t("docs.description")} />
        </div>
      }
      toolbar={
        failed ? undefined : (
          <div className={READING_MEASURE}>
            <FilterBar
              search={{
                value: query,
                onChange: onQuery,
                placeholder: t("docs.search"),
                testId: "docs-search",
              }}
            />
          </div>
        )
      }
    >
      <div className={cn(READING_MEASURE, "flex flex-col gap-10 pt-3")}>
        {body}
        <ReleaseLine version={releaseVersion(version)} />
      </div>
    </Page>
  );
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node)
    return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

const HEADING_CLASS: Record<2 | 3 | 4 | 5 | 6, string> = {
  2: "mt-8 mb-2 scroll-mt-6 text-base font-semibold leading-6",
  3: "mt-6 mb-2 scroll-mt-6 text-sm font-semibold leading-5",
  4: "mt-4 mb-1 scroll-mt-6 text-sm font-medium leading-5",
  5: "mt-4 mb-1 scroll-mt-6 text-sm font-medium leading-5 text-muted-foreground",
  6: "mt-4 mb-1 scroll-mt-6 text-xs font-medium leading-4 text-muted-foreground",
};

const LINK_CLASS = "font-medium text-primary underline underline-offset-4";

type MarkdownProps<T extends keyof JSX.IntrinsicElements> = ComponentProps<T> & {
  node?: unknown;
};

function articleComponents(
  bundle: DocsBundle,
  page: DocsPage,
  locale: Locale,
  doc: DocsArticle,
  externalLabel: string,
  imageCaption: (build: string) => string,
) {
  const heading =
    (depth: number) =>
    ({ children, node: _node, className: _className, ...props }: MarkdownProps<"h2">) => {
      const level = headingLevel(depth, doc.titleDepth);
      const Tag = `h${level}` as const;
      return (
        <Tag
          {...props}
          id={anchorFor(doc.headings, textOf(children))}
          data-document-level={depth}
          className={HEADING_CLASS[level]}
        >
          {children}
        </Tag>
      );
    };
  return {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    a: ({ href = "", children, node: _node, ...props }: MarkdownProps<"a">) => {
      const target = resolveLink(bundle, page, locale, href);
      if (target.kind === "anchor" || target.kind === "chapter")
        return (
          <Link
            to="/docs/$slug"
            params={{ slug: target.kind === "anchor" ? page.slug : target.slug }}
            hash={target.anchor}
            activeOptions={{ includeHash: true }}
            className={LINK_CLASS}
            data-testid="docs-chapter-link"
          >
            {children}
          </Link>
        );
      if (target.kind === "external")
        return (
          <a
            {...props}
            href={target.href}
            target="_blank"
            rel="noreferrer"
            className={LINK_CLASS}
            data-testid="docs-external-link"
          >
            {children}
            <ExternalLink aria-hidden="true" className="ml-0.5 inline size-3.5 align-[-2px]" />
            <span className="sr-only"> ({externalLabel})</span>
          </a>
        );
      if (target.kind === "route")
        return (
          <Link {...routerTarget(target.href)} className={LINK_CLASS} data-testid="docs-link">
            {children}
          </Link>
        );
      return (
        <a {...props} href={target.href} className={LINK_CLASS} data-testid="docs-link">
          {children}
        </a>
      );
    },
    img: ({ src, alt, node: _node }: MarkdownProps<"img">) => {
      if (typeof src !== "string" || !src) return null;
      const image = imageFor(page, locale, src);
      return (
        <span className="my-4 block" data-testid="docs-image">
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="block"
            data-testid="docs-image-link"
          >
            <img
              src={src}
              alt={alt ?? image?.alt ?? ""}
              loading="lazy"
              decoding="async"
              width={image?.width}
              height={image?.height}
              className="block h-auto w-full rounded-md border border-border"
            />
            <span className="sr-only"> ({externalLabel})</span>
          </a>
          {image?.build ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              {imageCaption(image.build)}
            </span>
          ) : null}
        </span>
      );
    },
    code: ({ children, className, node: _node, ...rest }: MarkdownProps<"code">) => {
      if (!("data-block" in rest))
        return (
          <code
            className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)}
            data-streamdown="inline-code"
          >
            {children}
          </code>
        );
      const lang = /language-(\S+)/.exec(className ?? "")?.[1];
      return (
        <CodeBlock
          code={textOf(children).replace(/\n$/, "")}
          lang={lang}
          label={lang}
          testId="docs-code"
        />
      );
    },
  };
}

function TocLinks({
  slug,
  toc,
  current,
  label,
}: {
  slug: string;
  toc: readonly DocsHeading[];
  current: string | undefined;
  label: string;
}) {
  const shallowest = Math.min(...toc.map((heading) => heading.depth));
  return (
    <nav aria-label={label} data-sk-slot="toc" className="flex flex-col gap-1">
      {toc.map((heading) => (
        <Link
          key={heading.anchor}
          to="/docs/$slug"
          params={{ slug }}
          hash={heading.anchor}
          activeOptions={{ includeHash: true }}
          data-testid="docs-toc-link"
          data-current={heading.anchor === current ? "true" : undefined}
          className={cn(
            "rounded-md px-2 py-1 text-sm leading-5 [overflow-wrap:anywhere] hover:bg-muted",
            heading.depth > shallowest && "pl-5",
            heading.anchor === current ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {heading.text.replace(/[`*_]/g, "")}
        </Link>
      ))}
    </nav>
  );
}

export function DocsArticlePage() {
  const session = useSession();
  const docs = useDocsBundle();
  const { slug = "" } = useParams({ strict: false }) as { slug?: string };
  if (docs.data && !findPage(docs.data, slug)) return <NotFoundPage />;
  return (
    <ReadingScroll testId="docs-scroll">
      {docs.isError ? (
        <div className={cn(READING_MEASURE, "pt-6")}>
          <LoadFailed onRetry={() => void docs.refetch()} error={docs.error} />
        </div>
      ) : (
        <Loadable loading={!docs.data} skeleton={<ReadingSkeleton />} testId="docs-article-loading">
          {docs.data ? (
            <DocsArticleView bundle={docs.data} slug={slug} version={session.version} />
          ) : null}
        </Loadable>
      )}
    </ReadingScroll>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const SCROLL_FRAMES = 10;
const SCROLL_POSITIONS = new Map<string, number>();

function revealHeading(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  return true;
}

function scrollRegion(root: HTMLElement | null): HTMLElement | null {
  return root?.closest<HTMLElement>('[data-sk-slot="scroll-region"]') ?? null;
}

function useDocsScroll(hash: string, anchor: RefObject<HTMLDivElement | null>) {
  const key = useRouterState({
    select: (state) => state.location.state.__TSR_key ?? state.location.href,
  });
  const current = useRef(key);
  useLayoutEffect(() => {
    current.current = key;
  }, [key]);
  useEffect(() => {
    const region = scrollRegion(anchor.current);
    if (!region) return;
    const record = () => SCROLL_POSITIONS.set(current.current, region.scrollTop);
    region.addEventListener("scroll", record, { passive: true });
    return () => region.removeEventListener("scroll", record);
  }, [anchor]);
  useEffect(() => {
    const region = scrollRegion(anchor.current);
    if (!region) return;
    const saved = SCROLL_POSITIONS.get(key);
    let frame = 0;
    let handle = 0;
    const settle = () => {
      if (hash) {
        if (revealHeading(hash)) return;
      } else if (saved === undefined) {
        region.scrollTo({ top: 0 });
        return;
      } else {
        region.scrollTop = saved;
        if (region.scrollTop >= saved) return;
      }
      frame += 1;
      if (frame < SCROLL_FRAMES) handle = requestAnimationFrame(settle);
    };
    settle();
    return () => cancelAnimationFrame(handle);
  }, [key, hash, anchor]);
}

const SPY_OFFSET = 96;

function useActiveHeading(
  toc: readonly DocsHeading[],
  hash: string,
  anchor: RefObject<HTMLDivElement | null>,
): string | undefined {
  const [spied, setSpied] = useState<{ key: string; anchor: string | undefined } | null>(null);
  const visit = useRouterState({
    select: (state) => state.location.state.__TSR_key ?? state.location.href,
  });
  const key = `${visit}|${hash}|${toc.map((heading) => heading.anchor).join(",")}`;
  useEffect(() => {
    const region = scrollRegion(anchor.current);
    if (!region || toc.length === 0) return;
    let mode = spyMode("following", { type: "navigate", hash });
    const engage = () => {
      mode = spyMode(mode, { type: "input" });
    };
    const inputs = ["wheel", "touchmove", "pointerdown"] as const;
    const update = () => {
      if (mode === "held") return;
      const top = region.getBoundingClientRect().top;
      const positions = toc.flatMap((heading) => {
        const element = region.ownerDocument.getElementById(heading.anchor);
        return element
          ? [{ anchor: heading.anchor, top: element.getBoundingClientRect().top - top }]
          : [];
      });
      const atBottom =
        region.scrollHeight > region.clientHeight &&
        region.scrollTop + region.clientHeight >= region.scrollHeight - 2;
      setSpied({
        key,
        anchor: activeHeading(positions, SPY_OFFSET, atBottom, hash, region.clientHeight),
      });
    };
    for (const input of inputs) region.addEventListener(input, engage, { passive: true });
    region.ownerDocument.addEventListener("keydown", engage);
    region.addEventListener("scroll", update, { passive: true });
    return () => {
      for (const input of inputs) region.removeEventListener(input, engage);
      region.ownerDocument.removeEventListener("keydown", engage);
      region.removeEventListener("scroll", update);
    };
  }, [anchor, toc, hash, key]);
  if (spied?.key === key && spied.anchor) return spied.anchor;
  return toc.some((heading) => heading.anchor === hash) ? hash : toc[0]?.anchor;
}

function PagerLink({
  bundle,
  page,
  current,
  direction,
  locale,
}: {
  bundle: DocsBundle;
  page: DocsPage;
  current: DocsPage;
  direction: "previous" | "next";
  locale: Locale;
}) {
  const { t } = useI18n();
  const crossing =
    page.section !== current.section ? sectionText(bundle, page.section, locale)?.title : null;
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  return (
    <Link
      to="/docs/$slug"
      params={{ slug: page.slug }}
      rel={direction === "previous" ? "prev" : "next"}
      data-testid={`docs-${direction}`}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border px-4 py-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        direction === "next" && "items-end text-right sm:col-start-2",
      )}
    >
      <span className="flex items-center gap-1 text-xs leading-4 text-muted-foreground">
        {direction === "previous" ? <Icon aria-hidden="true" className="size-3.5" /> : null}
        <span>
          {t(direction === "previous" ? "docs.previous" : "docs.next")}
          {crossing ? ` · ${crossing}` : null}
        </span>
        {direction === "next" ? <Icon aria-hidden="true" className="size-3.5" /> : null}
      </span>
      <span className="text-sm font-medium leading-5 [overflow-wrap:anywhere]">
        {localized(page, locale).title}
      </span>
    </Link>
  );
}

function PagerChoice({
  bundle,
  choice,
  current,
  locale,
}: {
  bundle: DocsBundle;
  choice: DocsChoice;
  current: DocsPage;
  locale: Locale;
}) {
  const { t } = useI18n();
  const choiceTitle = useChoiceTitle();
  const [first] = choice.pages;
  const crossing =
    first && first.section !== current.section
      ? sectionText(bundle, first.section, locale)?.title
      : null;
  return (
    <div
      data-testid="docs-next"
      data-choice={choice.id}
      className="flex min-w-0 flex-col gap-2 rounded-lg border px-4 py-3 sm:col-span-2"
    >
      <span className="flex items-center gap-1 text-xs leading-4 text-muted-foreground">
        <span>
          {t("docs.next")}
          {crossing ? ` · ${crossing}` : null}
        </span>
        <ChevronRight aria-hidden="true" className="size-3.5" />
      </span>
      <span className="text-sm font-medium leading-5 [overflow-wrap:anywhere]">
        {choiceTitle(
          choice.id,
          choice.pages.map((option) => localized(option, locale).title),
        )}
      </span>
      <div className="grid gap-2 sm:grid-cols-2">
        {choice.pages.map((option) => (
          <Link
            key={option.slug}
            to="/docs/$slug"
            params={{ slug: option.slug }}
            data-testid="docs-next-option"
            className={OPTION_CLASS}
          >
            <span className="text-sm font-medium leading-5 [overflow-wrap:anywhere]">
              {localized(option, locale).title}
            </span>
            <span className="line-clamp-2 text-sm leading-5 text-muted-foreground">
              {localized(option, locale).summary}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function DocsPager({
  bundle,
  page,
  locale,
}: {
  bundle: DocsBundle;
  page: DocsPage;
  locale: Locale;
}) {
  const { t } = useI18n();
  const { previous, next, choice } = neighbours(bundle, page.slug);
  if (!previous && !next) return null;
  return (
    <nav
      aria-label={t("docs.pager")}
      data-testid="docs-pager"
      className="grid gap-3 border-t pt-6 sm:grid-cols-2"
    >
      {previous ? (
        <PagerLink
          bundle={bundle}
          page={previous}
          current={page}
          direction="previous"
          locale={locale}
        />
      ) : null}
      {choice ? (
        <PagerChoice bundle={bundle} choice={choice} current={page} locale={locale} />
      ) : next ? (
        <PagerLink bundle={bundle} page={next} current={page} direction="next" locale={locale} />
      ) : null}
    </nav>
  );
}

const NO_HEADINGS: readonly DocsHeading[] = [];

const TABLE_CLASS = cn(
  "[&_table]:w-full [&_table]:min-w-full [&_table]:table-auto",
  "[&_th]:whitespace-normal [&_th]:align-bottom [&_th]:[overflow-wrap:break-word]",
  "[&_td]:whitespace-normal [&_td]:[overflow-wrap:break-word] [&_td_code]:break-words",
);

export function DocsArticleView({
  bundle,
  slug,
  version,
}: {
  bundle: DocsBundle;
  slug: string;
  version: string | null | undefined;
}) {
  const { t, locale } = useI18n();
  const rawHash = useRouterState({ select: (state) => state.location.hash });
  const hash = safeDecode(rawHash.replace(/^#/, ""));
  const top = useRef<HTMLDivElement>(null);
  useDocsScroll(hash, top);
  const page = findPage(bundle, slug);
  const doc = useMemo(() => (page ? article(page, locale) : null), [page, locale]);
  const current = useActiveHeading(doc?.toc ?? NO_HEADINGS, hash, top);
  const components = useMemo(
    () =>
      page && doc
        ? articleComponents(bundle, page, locale, doc, t("docs.external"), (build) =>
            t("docs.imageBuild", { build }),
          )
        : {},
    [bundle, page, locale, doc, t],
  );
  const remarkPlugins = useMemo(
    () => [
      ...Object.values(defaultRemarkPlugins),
      ...(page ? [chapterLinks(bundle, page, locale)] : []),
    ],
    [bundle, page, locale],
  );
  if (!page || !doc) return <NotFoundPage />;
  const onThisPage = t("docs.onThisPage");
  const section = sectionText(bundle, page.section, locale);
  return (
    <ReadingLayout
      ref={top}
      asideLabel={onThisPage}
      aside={
        doc.toc.length > 0 ? (
          <TocLinks slug={page.slug} toc={doc.toc} current={current} label={onThisPage} />
        ) : null
      }
    >
      <article
        data-testid="docs-article"
        data-sk-surface="detail"
        className="flex min-w-0 flex-col"
      >
        <PageHeader
          rhythm="reading"
          back={{ to: "/docs", label: t("docs.title") }}
          eyebrow={section?.title}
          title={doc.title}
          purpose={doc.lead ?? undefined}
        />
        <div className="flex min-w-0 flex-col gap-6">
          {doc.toc.length > 0 ? (
            <ReadingCompanion>
              <CollapsibleCard label={onThisPage} testId="docs-toc">
                <TocLinks slug={page.slug} toc={doc.toc} current={current} label={onThisPage} />
              </CollapsibleCard>
            </ReadingCompanion>
          ) : null}
          <section data-sk-slot="content" className="min-w-0">
            <MessageResponse
              key={`${page.slug}:${locale}`}
              controls={false}
              components={components}
              remarkPlugins={remarkPlugins}
              className={cn("text-sm", TABLE_CLASS)}
            >
              {doc.body}
            </MessageResponse>
          </section>
          <DocsPager bundle={bundle} page={page} locale={locale} />
          <ReleaseLine version={releaseVersion(version)} />
        </div>
      </article>
    </ReadingLayout>
  );
}
