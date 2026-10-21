import type { ReactNode } from "react";
import { useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";
import { ContextHelp } from "./context-help";
import { Skeleton } from "./skeleton";

export interface Fact {
  label: ReactNode;
  value: ReactNode;
  help?: ReactNode;
  testId?: string;
}

const GRID = "grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-2 text-sm";
const LINE = "flex flex-wrap items-center gap-x-3.5 gap-y-1 text-sm [&>div>dt]:min-w-[7.5rem]";
const BOX = "overflow-hidden rounded-lg border text-sm";
const ROW =
  "grid gap-0.5 border-t px-3.5 py-2.5 first:border-t-0 md:grid-cols-[minmax(7.5rem,12.5rem)_minmax(0,1fr)] md:gap-x-4";

export function FactList({
  items,
  loading,
  testId,
  layout = "default",
}: {
  items: readonly Fact[];
  loading?: boolean | number;
  testId?: string;
  layout?: "default" | "stacked";
}) {
  const phase = useLoadingPhase(loading !== undefined && loading !== false);
  if (phase !== "content") {
    const rows = typeof loading === "number" ? loading : items.length || 4;
    return (
      <div
        data-slot="fact-list"
        data-testid={testId}
        data-loading-phase={phase}
        role="status"
        aria-busy="true"
        className={cn(GRID, phase === "reserve" ? "invisible" : "sk-fade-in")}
      >
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="contents">
            <span className="flex h-5 items-center">
              <Skeleton className="h-3.5 w-24" />
            </span>
            <span className="flex h-5 items-center">
              <Skeleton className={cn("h-3.5", index % 2 ? "w-1/3" : "w-1/2")} />
            </span>
          </div>
        ))}
      </div>
    );
  }
  const stacked = layout === "stacked";
  const single = items.length === 1;
  return (
    <dl
      data-slot="fact-list"
      data-testid={testId}
      data-shape={stacked ? "stacked" : single ? "line" : "box"}
      className={stacked ? "space-y-3" : single ? LINE : BOX}
    >
      {items.map((item, index) => (
        <div
          key={item.testId ?? index}
          className={stacked ? undefined : single ? "contents" : ROW}
          data-testid={item.testId}
        >
          <dt className={cn("flex items-center gap-1 text-muted-foreground", stacked && "text-xs")}>
            {item.label}
            {item.help ? (
              <ContextHelp
                label={typeof item.label === "string" ? item.label : `${index}`}
                testId={`${item.testId ?? `${testId ?? "fact"}-${index}`}-help`}
              >
                {item.help}
              </ContextHelp>
            ) : null}
          </dt>
          <dd
            className={cn(
              stacked
                ? "mt-1 min-w-0 break-words"
                : single
                  ? "min-w-0 break-words"
                  : "min-w-0 font-medium break-words",
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
