import { useRouter, useRouterState } from "@tanstack/react-router";
import { Skeleton } from "@ui/atoms/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/molecules/tabs";
import { type ReactNode, useEffect, useState } from "react";
import { Loadable, RowsSkeleton } from "./skeleton";

export interface PageTab {
  value: string;
  label: string;
  count?: number;
  testId?: string;
  loading?: boolean;
  content: ReactNode;
}

export function tabFromSearch(
  search: string,
  param: string,
  values: readonly string[],
  fallback: string,
): string {
  const raw = new URLSearchParams(search).get(param);
  return raw !== null && values.includes(raw) ? raw : fallback;
}

const TAB_SHEET_PARAMS = ["step", "grant", "tool", "version"] as const;

export function searchWithTab(
  search: string,
  param: string,
  value: string,
  defaultValue: string,
): string {
  const params = new URLSearchParams(search);
  for (const sheet of TAB_SHEET_PARAMS) params.delete(sheet);
  if (value === defaultValue) params.delete(param);
  else params.set(param, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

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
    <Tabs
      value={active}
      onValueChange={choose}
      data-slot="page-tabs"
      data-testid={testId}
      className="pt-2"
    >
      <TabsList data-testid={`${testId}-list`}>
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            data-testid={tab.testId ?? `${testId}-tab-${tab.value}`}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className="text-xs tabular-nums text-muted-foreground">{tab.count}</span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) =>
        visited.has(tab.value) ? (
          <TabsContent
            key={tab.value}
            value={tab.value}
            forceMount
            hidden={tab.value !== active}
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
