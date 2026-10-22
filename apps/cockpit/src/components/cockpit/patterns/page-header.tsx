import { useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { absolute } from "@/app/links";
import { SidebarToggle, usePageFrameTrigger } from "@/app/shell-header";
import { useIsMobile } from "@/hooks/use-mobile";
import { useArrived, useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";
import { type ActionSpec, renderAction } from "./action-button";
import { listReturnHref, readListReturn } from "./list-return";
import { Skeleton } from "./skeleton";

export function PageHeader({
  title,
  eyebrow,
  back,
  badge,
  purpose,
  action,
  secondary,
  menu,
  loading,
  testId,
  rhythm = "compact",
}: {
  title: string;
  eyebrow?: string;
  back?: { to: string; label: string };
  badge?: ReactNode;
  purpose?: ReactNode;
  action?: ReactNode | ActionSpec;
  secondary?: ReactNode;
  menu?: ReactNode;
  loading?: boolean;
  testId?: string;
  rhythm?: "compact" | "reading";
}) {
  const ownsTrigger = usePageFrameTrigger();
  const isMobile = useIsMobile();
  const phase = useLoadingPhase(Boolean(loading));
  const arrived = useArrived(phase);
  const actions = secondary || menu || action;
  const loadingRow = phase !== "content";
  const reading = rhythm === "reading";
  return (
    <header
      data-family-slot="page-header"
      data-slot="page-header"
      data-testid={testId}
      data-header-rhythm={rhythm}
      data-loading-phase={loadingRow ? phase : undefined}
      aria-busy={loadingRow ? true : undefined}
      className={reading ? "flex flex-col pt-10 pb-6" : "flex flex-col gap-1 pt-6 pb-4"}
    >
      {back && reading ? (
        <div className="mb-6">
          <BackLink to={back.to} label={back.label} />
        </div>
      ) : back ? (
        <BackLink to={back.to} label={back.label} />
      ) : null}
      {eyebrow ? (
        <p
          data-slot="page-eyebrow"
          data-testid="page-eyebrow"
          className={cn("text-xs leading-4 font-medium text-muted-foreground", reading && "mb-2")}
        >
          {eyebrow}
        </p>
      ) : null}
      {loadingRow ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            phase === "reserve" ? "[&>[data-slot=skeleton]]:invisible" : "sk-fade-in",
          )}
          data-testid="page-title-row"
          data-slot="page-title-row"
        >
          {ownsTrigger && isMobile ? <SidebarToggle className="shrink-0" /> : null}
          {title ? <h1 className="sr-only">{title}</h1> : null}
          <Skeleton className="h-7 w-56 max-w-[60%]" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-9 w-full sm:ml-auto sm:h-8 sm:w-28" />
        </div>
      ) : (
        <div
          className={cn(
            "grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
            arrived && "sk-fade-in",
          )}
          data-slot="page-header-grid"
        >
          <div
            className="flex min-h-9 min-w-0 flex-wrap items-center gap-2"
            data-testid="page-title-row"
            data-slot="page-title-row"
          >
            {ownsTrigger && isMobile ? <SidebarToggle className="shrink-0" /> : null}
            <h1
              title={title}
              className="min-w-0 max-w-full text-2xl font-semibold leading-8 tracking-[-0.02em] [overflow-wrap:anywhere]"
            >
              {title}
            </h1>
            {badge}
          </div>
          {actions ? (
            <div
              data-slot="page-actions"
              className="order-last mt-2 flex w-full flex-wrap items-center gap-2 sm:order-none sm:mt-0 sm:w-auto sm:flex-nowrap sm:justify-end max-sm:[&>*:not([data-size^=icon])]:flex-1"
            >
              {secondary}
              {menu}
              {renderAction(action)}
            </div>
          ) : null}
          {purpose ? (
            <p
              data-slot="page-purpose"
              className="max-w-3xl text-sm text-muted-foreground sm:col-span-2"
            >
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

export function BackLink({ to, label }: { to: string; label: string }) {
  const router = useRouter();
  const href = absolute(listReturnHref(to, readListReturn(to)));
  return (
    <a
      href={href}
      data-slot="page-back"
      data-testid="detail-back"
      className={BACK_CLASS}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        router.history.push(href);
      }}
    >
      <ChevronLeft aria-hidden="true" className="-ml-1 size-4" />
      {label}
    </a>
  );
}
