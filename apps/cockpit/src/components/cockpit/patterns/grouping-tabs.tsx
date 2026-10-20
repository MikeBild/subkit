import { useRef } from "react";
import { cn } from "@/lib/utils";
import { useEdgeFade } from "./tab-motion";

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
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: readonly GroupingOption[];
  testId?: string;
  note?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const edgeFade = useEdgeFade(scroller);

  return (
    <div
      ref={scroller}
      style={edgeFade}
      role="tablist"
      aria-label={label}
      data-slot="grouping-tabs"
      data-testid={testId}
      className="scrollbar-none flex h-11 shrink-0 items-center gap-6 overflow-x-auto border-b"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          data-testid={testId ? `${testId}-${option.value}` : undefined}
          className={cn(
            "relative inline-flex h-9 shrink-0 items-center whitespace-nowrap text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            option.value === value &&
              "text-foreground after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:bg-foreground",
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
    </div>
  );
}
