import { useRouter, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface PageTab {
  value: string;
  label: string;
  count?: number;
  testId?: string;
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

  const choose = (value: string) => {
    const search = searchWithTab(currentSearch(), param, value, fallback);
    router.history.replace(`${window.location.pathname}${search}${window.location.hash}`);
  };

  return (
    <Tabs value={active} onValueChange={choose} data-slot="page-tabs" data-testid={testId}>
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabsList
          variant="line"
          className="w-full justify-start gap-4 rounded-none border-b p-0"
          data-testid={`${testId}-list`}
        >
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="flex-none px-0"
              data-testid={tab.testId ?? `${testId}-tab-${tab.value}`}
            >
              {tab.label}
              {tab.count !== undefined ? (
                <span className="text-xs tabular-nums text-muted-foreground">{tab.count}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((tab) =>
        visited.has(tab.value) ? (
          <TabsContent
            key={tab.value}
            value={tab.value}
            forceMount
            hidden={tab.value !== active}
            className="mt-4 flex flex-col gap-8"
          >
            {tab.content}
          </TabsContent>
        ) : null,
      )}
    </Tabs>
  );
}
