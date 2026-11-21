import { cn } from "@ui/lib/utils";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { SECTION_LABEL } from "./section";
import { STATUS_DOT, type StatusTone } from "./status-strip";

export type TimelineTone = StatusTone | "neutral";

export interface TimelineItem {
  id: string;
  tone: TimelineTone;
  title: ReactNode;
  time?: string;
  dateTime?: string;
  meta?: ReactNode;
  aside?: ReactNode;
  onOpen?(): void;
  label?: string;
  testId?: string;
}

export interface TimelineGroup {
  label?: string;
  items: readonly TimelineItem[];
}

const DOT: Record<TimelineTone, string> = {
  ...STATUS_DOT,
  neutral: "bg-muted-foreground/40",
};

const CARD =
  "flex min-w-0 flex-1 items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left text-sm";

const RAIL =
  "relative before:absolute before:-top-2 before:bottom-0 before:left-[5px] before:w-0.5 before:bg-border first:before:top-1/2 last:before:bottom-1/2";

function Entry({ item }: { item: TimelineItem }) {
  const body = (
    <>
      <span
        aria-hidden="true"
        data-slot="timeline-dot"
        data-tone={item.tone}
        className={cn(
          "relative z-10 size-3 shrink-0 rounded-full border-2 border-background",
          DOT[item.tone],
        )}
      />
      <span
        className={cn(
          CARD,
          item.onOpen && "transition-colors group-hover:bg-muted/50 group-focus-visible:ring-2",
        )}
        data-slot="timeline-card"
      >
        {item.time ? (
          <time
            dateTime={item.dateTime}
            className="min-w-11 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
            data-slot="timeline-time"
          >
            {item.time}
          </time>
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block font-medium [overflow-wrap:anywhere]">{item.title}</span>
          {item.meta ? (
            <span className="block truncate text-xs text-muted-foreground">{item.meta}</span>
          ) : null}
        </span>
        {item.aside ? <span className="flex shrink-0 items-center gap-2">{item.aside}</span> : null}
        {item.onOpen ? (
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : null}
      </span>
    </>
  );
  return (
    <li data-slot="timeline-item" data-testid={item.testId} className={RAIL}>
      {item.onOpen ? (
        <button
          type="button"
          onClick={item.onOpen}
          aria-label={item.label}
          data-testid={item.testId ? `${item.testId}-open` : undefined}
          className="group flex w-full items-center gap-3 rounded-lg text-left focus-visible:outline-none"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-3">{body}</div>
      )}
    </li>
  );
}

export function Timeline({
  groups,
  testId,
}: {
  groups: readonly TimelineGroup[];
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-4" data-slot="timeline" data-testid={testId}>
      {groups
        .filter((group) => group.items.length > 0)
        .map((group, index) => (
          <div key={group.label ?? index} data-slot="timeline-group">
            {group.label ? (
              <div className={cn("mb-2", SECTION_LABEL)} data-slot="timeline-group-label">
                {group.label}
              </div>
            ) : null}
            <ol className="flex flex-col gap-2">
              {group.items.map((item) => (
                <Entry key={item.id} item={item} />
              ))}
            </ol>
          </div>
        ))}
    </div>
  );
}
