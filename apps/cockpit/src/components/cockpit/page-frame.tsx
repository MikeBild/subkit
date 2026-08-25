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
  surface,
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
  surface?: "overview" | "decisions" | "collection" | "detail" | "form" | "installation" | "audit";
  children: ReactNode;
}) {
  // A reading column must be centred in the SAME box as its own heading, and
  // the padding must sit OUTSIDE that box in both places. Putting `p-8` on the
  // same element as `max-w-[780px]` makes the box include its own padding, so
  // the content starts exactly one padding-width right of the title naming it —
  // 32px at `lg`, plainly visible, and the reason this surface still looked
  // misaligned after the scrollbar gutter was fixed.
  const column =
    width === "column"
      ? "mx-auto w-full max-w-[780px]"
      : surface === "overview"
        ? "mx-auto w-full max-w-[1120px]"
        : undefined;
  // The scroll owner reserves the gutter symmetrically, so a growing body
  // cannot shift the centre. `both-edges` is the operative part; plain `stable`
  // would only move the step to the other side.
  const gutter = width === "column" ? "[scrollbar-gutter:stable_both-edges]" : undefined;

  return (
    <main
      className="flex min-h-0 flex-1 flex-col"
      data-testid={testId}
      data-family-surface={surface}
    >
      {/* Header and body carry the SAME horizontal padding at every breakpoint.
          They used to differ between `sm` and `lg` — 32px against 24px — which
          indented every page's content against its own heading in exactly the
          window sizes nobody screenshots. */}
      <header data-family-slot="page-header" className="shrink-0 border-b px-4 py-6 sm:px-6">
        <div
          className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", column)}
        >
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold leading-8 tracking-[-0.02em]">{title}</h1>
            {description && (
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action}
        </div>
      </header>
      {toolbar && (
        <div
          data-family-slot="filters"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6"
        >
          {toolbar}
        </div>
      )}
      {scroll === "content" ? (
        <div
          data-family-slot="content"
          className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", column)}
        >
          {children}
        </div>
      ) : (
        <div
          data-family-slot="content"
          className={cn(
            "min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-6 sm:px-6",
            gutter,
          )}
        >
          {/* The width cap goes on an inner element so the padding above stays
              outside it — the same nesting the header uses. */}
          <div className={column}>{children}</div>
        </div>
      )}
    </main>
  );
}
