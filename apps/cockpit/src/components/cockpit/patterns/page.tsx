import type { ReactNode } from "react";
import { FAMILY_UI_VERSION } from "@/components/family-ui";
import { cn } from "@/lib/utils";
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
  return kind === "workspace" ? "w-full" : "w-full max-w-[1280px]";
}

function gutter(kind: PageKind): string {
  return kind === "workspace" ? "" : "px-4 sm:px-6";
}

export function Page({
  kind,
  scroll,
  testId,
  surface,
  header,
  toolbar,
  children,
}: {
  kind: PageKind;
  scroll: "content" | "page";
  testId: string;
  surface?: PageSurface;
  header: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const column = pageColumn(kind);
  const pad = gutter(kind);
  return (
    <ColumnToggleScope>
      <main
        className="flex min-h-0 flex-1 flex-col"
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
        {scroll === "content" ? (
          <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", pad)}>
            <div
              data-family-slot="content"
              className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", column)}
            >
              {children}
            </div>
          </div>
        ) : (
          <div
            data-family-slot="scroll-region"
            className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-6", pad)}
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

export const READING_COLUMN = "mx-auto w-full max-w-3xl";
