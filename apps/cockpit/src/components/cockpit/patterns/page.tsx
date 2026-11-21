import type { PageFailureSpec } from "@ui/lib/errors";
import { cn } from "@ui/lib/utils";
import { ErrorState } from "@ui/molecules/error-notice";
import type { ReactNode } from "react";
import { FAMILY_UI_VERSION } from "@/components/family-ui";
import { ActionFailureHost } from "./action-failure";
import { ColumnToggleScope } from "./column-toggle-claim";
import { usePageFailure } from "./use-error-detail";

export type PageKind = "list" | "detail" | "settings" | "workspace";

export type PageSurface =
  | "overview"
  | "decisions"
  | "collection"
  | "detail"
  | "form"
  | "installation"
  | "audit";

export function pageColumn(kind: PageKind): string {
  if (kind === "workspace") return "w-full";
  return kind === "settings" ? "w-full max-w-[1440px]" : "w-full max-w-[1280px]";
}

const PAGE_GUTTER = "px-4 sm:px-8";

export function pageGutter(kind: PageKind): string {
  return kind === "workspace" ? "" : PAGE_GUTTER;
}

export function Page({
  kind,
  scroll,
  testId,
  surface,
  header,
  toolbar,
  failureHost = true,
  failure = null,
  children,
}: {
  kind: PageKind;
  scroll: "content" | "page";
  testId: string;
  surface?: PageSurface;
  header: ReactNode;
  toolbar?: ReactNode;
  failureHost?: boolean;
  failure?: PageFailureSpec | null;
  children: ReactNode;
}) {
  const column = pageColumn(kind);
  const pad = pageGutter(kind);
  const failed = usePageFailure(failure);
  return (
    <ColumnToggleScope>
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid={testId}
        data-family-surface={surface}
        data-family-contract-version={FAMILY_UI_VERSION}
        data-page-kind={kind}
        data-page-failed={failure ? "true" : undefined}
      >
        {failure ? (
          <div className={cn("min-h-0 flex-1 overflow-y-auto", PAGE_GUTTER)} data-slot="page-error">
            {failed ? <ErrorState {...failed} heading="h1" /> : null}
          </div>
        ) : (
          <>
            {header ? (
              <div className={cn("shrink-0", PAGE_GUTTER)}>
                <div className={column}>{header}</div>
              </div>
            ) : null}
            {toolbar ? (
              <div className={cn("shrink-0 pb-3", pad)}>
                <div
                  data-family-slot="filters"
                  className={cn("flex flex-wrap items-center gap-2", column)}
                >
                  {toolbar}
                </div>
              </div>
            ) : null}
            {failureHost ? (
              <div className={cn("shrink-0 empty:hidden", pad)} data-slot="page-failure">
                <ActionFailureHost level="page" className={cn("pb-3", column)} />
              </div>
            ) : null}
            {scroll === "content" ? (
              <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-clip", pad)}>
                <div
                  data-family-slot="content"
                  className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-clip", column)}
                >
                  {children}
                </div>
              </div>
            ) : (
              <div
                data-family-slot="scroll-region"
                className={cn("min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-6", pad)}
              >
                <div data-family-slot="content" className={column}>
                  {children}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </ColumnToggleScope>
  );
}

export const READING_COLUMN = "w-full max-w-3xl";
