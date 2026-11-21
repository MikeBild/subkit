import { Button } from "@ui/atoms/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/atoms/collapsible";
import { Skeleton } from "@ui/atoms/skeleton";
import { cn } from "@ui/lib/utils";
import { ChevronDown } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { pageColumn, pageGutter } from "./page";

export const READING_MEASURE = "w-full min-w-0 max-w-[780px]";

const LAYOUT = "flex items-start gap-10";
const COLUMN = "min-w-0 max-w-[780px] flex-1";
const ASIDE = "sticky top-0 hidden w-56 flex-none self-start xl:block";

export function ReadingScroll({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        data-family-slot="scroll-region"
        data-testid={testId}
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-6",
          pageGutter("detail"),
        )}
      >
        <div data-family-slot="content" className={pageColumn("detail")}>
          {children}
        </div>
      </div>
    </main>
  );
}

export function ReadingLayout({
  aside,
  asideLabel,
  children,
  ref,
}: {
  aside?: ReactNode;
  asideLabel?: string;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} data-slot="reading-layout" className={LAYOUT}>
      <div className={COLUMN}>{children}</div>
      {aside ? (
        <aside data-family-slot="page-toc" className={ASIDE}>
          <div className="max-h-[calc(100dvh-3rem)] overflow-y-auto pt-10 pb-6">
            {asideLabel ? (
              <p className="mb-2 px-2 text-xs leading-4 font-medium text-muted-foreground">
                {asideLabel}
              </p>
            ) : null}
            {aside}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

export function ReadingCompanion({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 xl:hidden" data-family-slot="facts">
      {children}
    </div>
  );
}

export function CollapsibleCard({
  label,
  defaultOpen = false,
  testId,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      data-testid={testId}
      className="group/card rounded-2xl border bg-card"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between rounded-2xl px-4"
          data-testid={`${testId}-toggle`}
        >
          <span>{label}</span>
          <ChevronDown
            data-icon="inline-end"
            className="transition-transform duration-(--sk-dur-base) group-data-[state=open]/card:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-2 py-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function lines(count: number, last = "w-3/5") {
  return Array.from({ length: count }, (_, index) => (
    <Skeleton key={index} className={cn("h-4", index === count - 1 ? last : "w-full")} />
  ));
}

export function ReadingSkeleton() {
  return (
    <div data-slot="reading-layout" className={LAYOUT}>
      <div className={COLUMN} data-family-state="loading">
        <div className="flex flex-col pt-10 pb-6">
          <Skeleton className="mb-6 h-5 w-28" />
          <Skeleton className="mb-2 h-4 w-24" />
          <Skeleton className="h-8 w-72 max-w-[70%]" />
        </div>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">{lines(4)}</div>
          <Skeleton className="h-6 w-48" />
          <div className="flex flex-col gap-3">{lines(3, "w-2/5")}</div>
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-6 w-40" />
          <div className="flex flex-col gap-3">{lines(5)}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
          <Skeleton className="h-4 w-36" />
        </div>
      </div>
      <aside data-family-slot="page-toc" className={ASIDE} aria-hidden="true">
        <div className="flex flex-col gap-3 px-2 pt-10">
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className={cn("h-4", index % 3 === 0 ? "w-4/5" : "w-full")} />
          ))}
        </div>
      </aside>
    </div>
  );
}
