import { useRouter, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Loadable, RowsSkeleton, Skeleton } from "./skeleton";
import { TAB_INDICATOR, useEdgeFade, useTabIndicator } from "./tab-motion";

export interface PageTab {
  value: string;
  label: string;
  count?: number;
  testId?: string;
  /** The panel's data is still loading: it shows a summary line and rows in their final shape. */
  loading?: boolean;
  content: ReactNode;
}

/** The tab an address names, or the fallback for a missing or unknown one. */
export function tabFromSearch(
  search: string,
  param: string,
  values: readonly string[],
  fallback: string,
): string {
  const raw = new URLSearchParams(search).get(param);
  return raw !== null && values.includes(raw) ? raw : fallback;
}

/**
 * The query string with one tab chosen. The default tab is left out of the
 * address; every other parameter stays exactly as it was.
 */
export function searchWithTab(
  search: string,
  param: string,
  value: string,
  defaultValue: string,
): string {
  const params = new URLSearchParams(search);
  if (value === defaultValue) params.delete(param);
  else params.set(param, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

/**
 * The page's tab bar (P4), bound to the address (`?tab=` / `?section=`) so a
 * reload and a link land on the same tab. Choosing a tab replaces the history
 * entry rather than adding one. A panel mounts the first time its tab is
 * shown and then stays mounted, hidden, so a reader's place in it survives
 * switching away. Never nested.
 */
export function PageTabs({
  tabs,
  param,
  testId,
  defaultValue,
}: {
  tabs: readonly PageTab[];
  param: "tab" | "section";
  testId: string;
  defaultValue?: string;
}) {
  const router = useRouter();
  // Subscribed for the re-render: the value is read from the raw address,
  // because the router's own search state is JSON-parsed.
  useRouterState({ select: (state) => state.location.href });
  const [, setPopped] = useState(0);
  useEffect(() => {
    const onPop = () => setPopped((count) => count + 1);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const values = tabs.map((tab) => tab.value);
  const fallback = defaultValue && values.includes(defaultValue) ? defaultValue : (values[0] ?? "");
  const active = tabFromSearch(currentSearch(), param, values, fallback);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([active]));
  if (!visited.has(active)) setVisited(new Set([...visited, active]));

  const list = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const indicator = useTabIndicator(list, '[data-state="active"]', active);
  const edgeFade = useEdgeFade(scroller);

  const choose = (value: string) => {
    const search = searchWithTab(currentSearch(), param, value, fallback);
    router.history.replace(`${window.location.pathname}${search}${window.location.hash}`);
  };

  return (
    <Tabs value={active} onValueChange={choose} data-slot="page-tabs" data-testid={testId}>
      <div ref={scroller} style={edgeFade} className="scrollbar-none overflow-x-auto">
        <TabsList
          ref={list}
          variant="line"
          className="relative w-full min-w-max justify-start gap-4 rounded-none border-b p-0"
          data-testid={`${testId}-list`}
        >
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              // The bar's one sliding underline replaces each tab's own.
              className={cn("flex-none px-0", indicator && "after:hidden")}
              data-testid={tab.testId ?? `${testId}-tab-${tab.value}`}
            >
              {tab.label}
              {tab.count !== undefined ? (
                <span className="text-xs tabular-nums text-muted-foreground">{tab.count}</span>
              ) : null}
            </TabsTrigger>
          ))}
          {indicator ? (
            <span
              aria-hidden="true"
              data-slot="page-tabs-indicator"
              className={cn(TAB_INDICATOR, "-bottom-px")}
              style={indicator}
            />
          ) : null}
        </TabsList>
      </div>
      {tabs.map((tab) =>
        visited.has(tab.value) ? (
          <TabsContent
            key={tab.value}
            value={tab.value}
            forceMount
            hidden={tab.value !== active}
            // A hidden panel is `display: none`; showing it again restarts the
            // fade, so each switch crossfades without any state of its own.
            className="sk-fade-in mt-4 flex flex-col gap-8"
          >
            <Loadable
              loading={tab.loading}
              className="flex flex-col gap-8"
              skeleton={
                <div className="flex flex-col gap-8">
                  <span className="flex h-5 items-center">
                    <Skeleton className="h-4 w-72 max-w-full" />
                  </span>
                  <RowsSkeleton count={5} />
                </div>
              }
            >
              {tab.content}
            </Loadable>
          </TabsContent>
        ) : null,
      )}
    </Tabs>
  );
}
