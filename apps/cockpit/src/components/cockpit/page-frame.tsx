import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one page shell every list, table and admin surface renders into.
 *
 * Before this existed, seven page modules each wrote their own header: three
 * different paddings, two title sizes, and six of them hid the page's one
 * explaining sentence behind a help icon. The description is a visible
 * paragraph here — a page description is what the page is *for* (CUI-WORDS-1),
 * and a sentence nobody can see without hovering is not a description.
 */
export function PageFrame({
  testId,
  title,
  description,
  action,
  toolbar,
  scroll,
  width = "full",
  children,
}: {
  testId: string;
  title: string;
  description?: string;
  /** The single primary action of this surface (CUI-ACT-4). */
  action?: ReactNode;
  /** Search, filters and other controls that narrow what the body shows. */
  toolbar?: ReactNode;
  /**
   * `content` hands the scroll to the body (a table owns its own viewport);
   * `page` scrolls the whole body and pads it.
   */
  scroll: "content" | "page";
  width?: "full" | "column";
  children: ReactNode;
}) {
  // A reading column must be centred in the SAME box as its own heading.
  // Centring only the content leaves the column offset by half a scrollbar
  // from the title that names it, which reads as a broken page.
  const column = width === "column" ? "mx-auto w-full max-w-[780px]" : undefined;
  // And the scroll owner has to reserve the gutter, or the column re-acquires
  // that same offset the moment the body outgrows one screen — invisible on
  // overlay scrollbars, which is exactly how it shipped unnoticed.
  const gutter = width === "column" ? "[scrollbar-gutter:stable_both-edges]" : undefined;

  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <header className="shrink-0 border-b px-5 py-4 sm:px-8">
        <div
          className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", column)}
        >
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
            {description && (
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action}
        </div>
      </header>
      {toolbar && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-3 sm:px-8">
          {toolbar}
        </div>
      )}
      {scroll === "content" ? (
        <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", column)}>{children}</div>
      ) : (
        <div className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto", gutter)}>
          <div className={cn("p-4 sm:p-6 lg:p-8", column)}>{children}</div>
        </div>
      )}
    </main>
  );
}
