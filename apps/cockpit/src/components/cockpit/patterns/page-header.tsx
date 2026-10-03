import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { SidebarToggle, usePageFrameTrigger } from "@/app/shell-header";
import { useArrived, useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";
import { type ActionSpec, renderAction } from "./action-button";
import { Skeleton } from "./skeleton";

/**
 * The page's header (P2) and the only place an h1 renders.
 *
 * back · [toggle] h1 badge … actions, then the purpose line below. The actions
 * are centred on the h1 row, not on the whole header, so a purpose that wraps
 * never pushes them down. On a phone they take their own row at full width.
 *
 * The back link is the whole breadcrumb (D3): "‹ Workflows" on a record's
 * page, never the record's own name — the h1 already says that.
 */
export function PageHeader({
  title,
  back,
  badge,
  purpose,
  action,
  secondary,
  menu,
  loading,
  testId,
}: {
  title: string;
  /** The list this record belongs to — detail pages only. */
  back?: { to: string; label: string };
  /** A `StatusBadge`, on the h1 row. */
  badge?: ReactNode;
  /** One line under the title, where the title alone does not say what the page is for. */
  purpose?: ReactNode;
  /** The single filled page action: an element, or an `ActionSpec` (`variant: "primary"`). */
  action?: ReactNode | ActionSpec;
  /** Visible outline actions. */
  secondary?: ReactNode;
  /** The page's `ActionMenu`. */
  menu?: ReactNode;
  /**
   * The record is still loading: the title row keeps its final shape — a
   * title bar, a badge and an action placeholder — so nothing moves when it
   * arrives.
   */
  loading?: boolean;
  testId?: string;
}) {
  const ownsTrigger = usePageFrameTrigger();
  const phase = useLoadingPhase(Boolean(loading));
  const arrived = useArrived(phase);
  const actions = secondary || menu || action;
  const loadingRow = phase !== "content";
  return (
    <header
      data-family-slot="page-header"
      data-slot="page-header"
      data-testid={testId}
      data-loading-phase={loadingRow ? phase : undefined}
      aria-busy={loadingRow ? true : undefined}
      className="flex flex-col gap-1 pt-6 pb-4"
    >
      {back ? <BackLink to={back.to} label={back.label} /> : null}
      {loadingRow ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            phase === "reserve" ? "[&>[data-slot=skeleton]]:invisible" : "sk-fade-in",
          )}
          data-testid="page-title-row"
          data-slot="page-title-row"
        >
          {ownsTrigger ? <SidebarToggle className="shrink-0" /> : null}
          {title ? <h1 className="sr-only">{title}</h1> : null}
          <Skeleton className="h-7 w-56 max-w-[60%]" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-9 w-full sm:ml-auto sm:h-8 sm:w-28" />
        </div>
      ) : (
        <div className={arrived ? "sk-fade-in" : undefined}>
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="page-title-row"
            data-slot="page-title-row"
          >
            {ownsTrigger ? <SidebarToggle className="shrink-0" /> : null}
            <h1 className="min-w-0 text-2xl font-semibold leading-8 tracking-[-0.02em]">{title}</h1>
            {badge}
            {actions ? (
              <div
                data-slot="page-actions"
                className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap max-sm:[&>*:not([data-size^=icon])]:flex-1"
              >
                {secondary}
                {menu}
                {renderAction(action)}
              </div>
            ) : null}
          </div>
          {purpose ? (
            <p data-slot="page-purpose" className="mt-1 text-sm text-muted-foreground">
              {purpose}
            </p>
          ) : null}
        </div>
      )}
    </header>
  );
}

const BACK_CLASS =
  "inline-flex w-fit items-center gap-0.5 rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** "‹ {Liste}" — the way back from a record to its list. */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} data-slot="page-back" data-testid="detail-back" className={BACK_CLASS}>
      <ChevronLeft aria-hidden="true" className="-ml-1 size-4" />
      {label}
    </Link>
  );
}
