import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

export interface ChoiceCardItem {
  icon: ReactNode;
  title: string;
  line: string;
  onSelect(): void;
  testId: string;
}

export function ChoiceCards({
  items,
  compact = false,
}: {
  items: readonly ChoiceCardItem[];
  compact?: boolean;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "grid",
        compact ? "gap-2 sm:grid-cols-2" : "gap-3",
        !compact && (items.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"),
      )}
      data-slot="choices"
    >
      {items.map((item, index) => (
        <button
          key={item.testId}
          type="button"
          onClick={item.onSelect}
          aria-labelledby={`${id}-${index}-t`}
          aria-describedby={`${id}-${index}-d`}
          className={cn(
            "grid w-full min-w-0 content-start items-start rounded-lg border bg-background text-left transition-colors hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            compact
              ? "grid-cols-[28px_minmax(0,1fr)] gap-x-2 gap-y-0.5 px-3 py-2"
              : "grid-cols-[36px_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)] sm:gap-y-1 sm:p-4",
          )}
          data-slot="choice-card"
          data-testid={item.testId}
        >
          <span
            className={cn(
              "row-span-2 grid place-items-center rounded-md bg-muted text-foreground",
              compact
                ? "size-7 [&_svg]:size-4"
                : "size-9 sm:row-span-1 sm:mb-2 [&_svg]:size-[18px]",
            )}
            aria-hidden="true"
          >
            {item.icon}
          </span>
          <span id={`${id}-${index}-t`} className="text-sm leading-5 font-medium">
            {item.title}
          </span>
          <span
            id={`${id}-${index}-d`}
            className="text-[13px] leading-[18px] text-muted-foreground"
          >
            {item.line}
          </span>
        </button>
      ))}
    </div>
  );
}
