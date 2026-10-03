import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/lib/i18n-context";

export type SheetSize = "default" | "wide";

/** The two sheet widths (§4); there are no others. */
export function sheetWidthClass(size: SheetSize): string {
  return size === "wide" ? "sm:max-w-5xl" : "sm:max-w-xl";
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
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={`w-full overflow-y-auto ${sheetWidthClass(size)}`}
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
        <div className="flex flex-col gap-6 p-4 pt-0">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
