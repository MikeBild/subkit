import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export interface RouteTab {
  /** Router-relative path of the tab's own page. */
  to: string;
  label: string;
  testId?: string;
}

/** The tab a path stands on: the tab whose page it is, or whose record it shows. */
export function activeRouteTab(pathname: string, tabs: readonly RouteTab[]): string | null {
  const path = pathname.replace(/^\/cockpit(?=\/|$)/, "") || "/";
  return tabs.find((tab) => path === tab.to || path.startsWith(`${tab.to}/`))?.to ?? null;
}

/**
 * The tab bar of a page whose tabs are pages of their own (P4, route form):
 * Wissen's sources, skills and files are each an address, so the tab is the
 * path rather than a query parameter. It looks and sits like `PageTabs`, and
 * like it is never nested.
 */
export function RouteTabs({
  tabs,
  label,
  testId,
}: {
  tabs: readonly RouteTab[];
  /** What the tab bar is, for assistive technology. */
  label: string;
  testId: string;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = activeRouteTab(pathname, tabs);
  return (
    <nav
      aria-label={label}
      data-slot="page-tabs"
      data-testid={testId}
      className="flex overflow-x-auto border-b"
    >
      {tabs.map((tab) => {
        const current = tab.to === active;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={current ? "page" : undefined}
            data-state={current ? "active" : "inactive"}
            data-testid={tab.testId ?? `${testId}-${tab.to.replace(/^\//, "")}`}
            className={cn(
              "relative inline-flex h-9 shrink-0 items-center px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              current &&
                "text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
