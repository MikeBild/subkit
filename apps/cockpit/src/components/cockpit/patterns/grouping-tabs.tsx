import { useRef } from "react";
import { cn } from "@/lib/utils";
import { TAB_INDICATOR, useEdgeFade, useTabIndicator } from "./tab-motion";

export interface GroupingOption {
  value: string;
  label: string;
}

export function GroupingTabs({
  label,
  value,
  onChange,
  options,
  testId,
  note,
  className,
  itemTestIdPrefix,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: readonly GroupingOption[];
  testId?: string;
  note?: string;
  className?: string;
  itemTestIdPrefix?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const edgeFade = useEdgeFade(scroller);
  const indicator = useTabIndicator(scroller, '[aria-selected="true"]', value);

  return (
    <div
      ref={scroller}
      style={edgeFade}
      role="tablist"
      aria-label={label}
      data-slot="grouping-tabs"
      data-testid={testId}
      className={cn(
        "scrollbar-none relative flex h-9 shrink-0 items-center gap-6 overflow-x-auto border-b pointer-coarse:h-11",
        className,
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          data-testid={
            itemTestIdPrefix
              ? `${itemTestIdPrefix}-${option.value}`
              : testId
                ? `${testId}-${option.value}`
                : undefined
          }
          className={cn(
            "relative inline-flex h-9 shrink-0 items-center whitespace-nowrap pointer-coarse:h-11 pointer-coarse:after:absolute pointer-coarse:after:inset-y-0 pointer-coarse:after:-inset-x-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            option.value === value && "text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
      {note ? (
        <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground md:inline">
          {note}
        </span>
      ) : null}
      {indicator ? (
        <span
          aria-hidden="true"
          data-slot="grouping-tabs-indicator"
          className={cn(TAB_INDICATOR, "-bottom-px")}
          style={indicator}
        />
      ) : null}
    </div>
  );
}
