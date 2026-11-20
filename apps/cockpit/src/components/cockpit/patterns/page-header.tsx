import { useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { absolute } from "@/app/links";
import { usePageFrameTrigger } from "@/app/shell-header";
import { SidePanelToggle, useSidePanelAvailable } from "@/app/side-panel";
import { FeedbackButton } from "@/features/feedback/feedback-entry";
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
  loadingPurpose,
  purposeLines = 1,
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
  loadingPurpose?: boolean;
  purposeLines?: 1 | 2;
  testId?: string;
  rhythm?: "compact" | "reading";
}) {
  const pageOwned = usePageFrameTrigger();
  const panelToggle = useSidePanelAvailable() && pageOwned;
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
      className={cn("@container flex flex-col", reading ? "pt-10 pb-6" : "gap-1 pt-6 pb-4")}
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
            "flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1",
            phase === "reserve" ? "[&>[data-slot=skeleton]]:invisible" : "sk-fade-in",
          )}
          data-testid="page-title-row"
          data-slot="page-title-row"
        >
          {title ? <h1 className="sr-only">{title}</h1> : null}
          <Skeleton className="h-7 w-56 max-w-[60%]" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-9 w-full sm:ml-auto sm:w-28" />
          {loadingPurpose ? (
            <span
              className={cn(
                "flex basis-full items-start pt-0.5",
                purposeLines === 2 ? "h-10" : "h-5",
              )}
              data-slot="page-purpose-loading"
            >
              <Skeleton className="h-3.5 w-2/3 max-w-xl" />
            </span>
          ) : null}
        </div>
      ) : (
        <div
          className={cn(
            "grid gap-x-4 gap-y-1 @2xl:grid-cols-[minmax(0,1fr)_auto] @2xl:items-center",
            arrived && "sk-fade-in",
          )}
          data-slot="page-header-grid"
        >
          <div
            className="flex min-h-9 min-w-0 flex-wrap items-center gap-2"
            data-testid="page-title-row"
            data-slot="page-title-row"
          >
            <h1
              title={title}
              className="min-w-0 max-w-full text-2xl font-semibold leading-8 tracking-[-0.02em] [overflow-wrap:anywhere]"
            >
              {title}
            </h1>
            {badge}
          </div>
          {actions || panelToggle ? (
            <div
              data-slot="page-actions"
              className="order-last mt-2 flex min-h-8 w-full flex-wrap items-center gap-2 @2xl:order-none @2xl:mt-0 @2xl:w-auto @2xl:flex-nowrap @2xl:justify-end max-sm:[&>*:not([data-size^=icon])]:flex-1"
            >
              {secondary}
              {renderAction(action)}
              {menu}
              {panelToggle ? (
                <>
                  <FeedbackButton
                    className="shrink-0 @max-2xl:ml-auto"
                    labelClassName="@max-3xl:sr-only"
                  />
                  <SidePanelToggle className="shrink-0" />
                </>
              ) : null}
            </div>
          ) : null}
          {purpose ? (
            <p
              data-slot="page-purpose"
              data-purpose-lines={purposeLines}
              className={cn(
                "max-w-3xl text-sm text-muted-foreground @2xl:col-span-2",
                purposeLines === 2 && "line-clamp-2 min-h-10",
              )}
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
  "relative inline-flex w-fit items-center gap-0.5 rounded-sm text-sm text-muted-foreground underline-offset-4 pointer-coarse:after:absolute pointer-coarse:after:-inset-x-2 pointer-coarse:after:-inset-y-3 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
