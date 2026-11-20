import type { ReactNode } from "react";
import { FAMILY_UI_VERSION } from "@/components/family-ui";
import { cn } from "@/lib/utils";
import { ActionFailureHost } from "./action-failure";
import { ColumnToggleScope } from "./column-toggle-claim";

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

export function pageGutter(kind: PageKind): string {
  return kind === "workspace" ? "" : "px-4 sm:px-6";
}

export function Page({
  kind,
  scroll,
  testId,
  surface,
  header,
  toolbar,
  failureHost = true,
  children,
}: {
  kind: PageKind;
  scroll: "content" | "page";
  testId: string;
  surface?: PageSurface;
  header: ReactNode;
  toolbar?: ReactNode;
  failureHost?: boolean;
  children: ReactNode;
}) {
  const column = pageColumn(kind);
  const pad = pageGutter(kind);
  return (
    <ColumnToggleScope>
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid={testId}
        data-family-surface={surface}
        data-family-contract-version={FAMILY_UI_VERSION}
        data-page-kind={kind}
      >
        {header ? (
          <div className={cn("shrink-0", pad)}>
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
      </main>
    </ColumnToggleScope>
  );
}

export const READING_COLUMN = "w-full max-w-3xl";
