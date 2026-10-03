import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/lib/i18n-context";
import { Loadable, RowsSkeleton, Skeleton } from "./skeleton";

export type SheetSize = "default" | "wide";

/**
 * The two sheet widths (§4); there are no others. Stated for the right-hand
 * side the sheet opens on, so they replace the primitive's own side width
 * instead of losing to it; below `sm` every sheet takes the full width.
 */
export function sheetWidthClass(size: SheetSize): string {
  return size === "wide" ? "data-[side=right]:sm:max-w-5xl" : "data-[side=right]:sm:max-w-xl";
}

/** The body of a record still loading: a fact list's shape, then rows. */
function SheetBodySkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="contents">
            <span className="flex h-5 items-center">
              <Skeleton className="h-3.5 w-24" />
            </span>
            <span className="flex h-5 items-center">
              <Skeleton className={index % 2 ? "h-3.5 w-1/3" : "h-3.5 w-1/2"} />
            </span>
          </div>
        ))}
      </div>
      <RowsSkeleton count={3} />
    </div>
  );
}

/**
 * Every row detail and every overlay that is not a dialog (P8): a header as on
 * a page (title, badge, actions), the body, no footer.
 */
export function RecordSheet({
  open,
  onOpenChange,
  size = "default",
  title,
  badge,
  back,
  action,
  menu,
  testId,
  closeTestId,
  titleTestId,
  loading,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  size?: SheetSize;
  title: ReactNode;
  badge?: ReactNode;
  /** Inside a wide sheet: the way back to the list it was opened from ("‹ Alle Läufe"). */
  back?: { label: string; onClick(): void };
  action?: ReactNode;
  menu?: ReactNode;
  testId: string;
  closeTestId?: string;
  titleTestId?: string;
  /** The record is still loading: the body holds a skeleton of its final shape. */
  loading?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={`overflow-y-auto data-[side=right]:w-full ${sheetWidthClass(size)}`}
        closeLabel={t("common.close")}
        closeTestId={closeTestId}
        data-testid={testId}
        data-sheet-size={size}
        aria-describedby={undefined}
      >
        <SheetHeader className="gap-1 pr-10">
          {back ? (
            <button
              type="button"
              onClick={back.onClick}
              data-slot="sheet-back"
              data-testid={`${testId}-back`}
              className="inline-flex w-fit items-center gap-0.5 rounded-sm text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              <ChevronLeft aria-hidden="true" className="-ml-1 size-4" />
              {back.label}
            </button>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle data-testid={titleTestId} className="flex min-w-0 items-center gap-2">
              {title}
            </SheetTitle>
            {badge}
            {action || menu ? (
              <span className="ml-auto flex items-center gap-2">
                {menu}
                {action}
              </span>
            ) : null}
          </div>
        </SheetHeader>
        <Loadable
          loading={loading}
          skeleton={<SheetBodySkeleton />}
          className="flex flex-col gap-6 p-4 pt-0"
        >
          {children}
        </Loadable>
      </SheetContent>
    </Sheet>
  );
}
