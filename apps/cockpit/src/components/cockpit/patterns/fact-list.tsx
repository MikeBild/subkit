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

export function FactList({
  items,
  loading,
  testId,
}: {
  items: readonly Fact[];
  loading?: boolean | number;
  testId?: string;
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
  return (
    <dl data-slot="fact-list" data-testid={testId} className={GRID}>
      {items.map((item, index) => (
        <div key={item.testId ?? index} className="contents" data-testid={item.testId}>
          <dt className="flex items-center gap-1 text-muted-foreground">
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
          <dd className="min-w-0 break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
