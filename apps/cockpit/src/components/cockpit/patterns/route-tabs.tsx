import { Link, useRouterState } from "@tanstack/react-router";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { useEdgeFade } from "./tab-motion";

export interface RouteTab {
  to: string;
  label: string;
  testId?: string;
}

export function activeRouteTab(pathname: string, tabs: readonly RouteTab[]): string | null {
  const path = pathname.replace(/^\/cockpit(?=\/|$)/, "") || "/";
  return tabs.find((tab) => path === tab.to || path.startsWith(`${tab.to}/`))?.to ?? null;
}

export function RouteTabs({
  tabs,
  label,
  testId,
}: {
  tabs: readonly RouteTab[];
  label: string;
  testId: string;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = activeRouteTab(pathname, tabs);
  const scroller = useRef<HTMLElement>(null);
  const edgeFade = useEdgeFade(scroller);
  return (
    <nav
      aria-label={label}
      data-slot="page-tabs"
      data-testid={testId}
      ref={scroller}
      style={edgeFade}
      className="scrollbar-none flex overflow-x-auto border-b"
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
              "relative inline-flex h-9 shrink-0 items-center px-3 pointer-coarse:h-11 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
