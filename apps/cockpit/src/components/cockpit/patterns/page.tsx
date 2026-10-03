import type { ReactNode } from "react";
import { FAMILY_UI_VERSION } from "@/components/family-ui";
import { cn } from "@/lib/utils";
import { ColumnToggleScope } from "./column-toggle-claim";

/**
 * `workspace` is Chat's: the page is its own two-pane surface, edge to edge
 * beside the sidebar, and draws its own columns (the reading column inside).
 */
export type PageKind = "list" | "detail" | "settings" | "workspace";

export type PageSurface =
  | "overview"
  | "decisions"
  | "collection"
  | "detail"
  | "form"
  | "installation"
  | "audit";

/**
 * The content column of each kind of page (§4). Left-aligned, never centred:
 * the left edge stays where it is when a reader moves from a list to one of
 * its records. Lists and settings take the list width, a record the reading
 * width, and the header uses the same column as the body below it.
 */
export function pageColumn(kind: PageKind): string {
  if (kind === "workspace") return "w-full";
  return kind === "detail" ? "w-full max-w-[880px]" : "w-full max-w-[1280px]";
}

/** The side padding outside the column: none for a workspace, which runs edge to edge. */
function gutter(kind: PageKind): string {
  return kind === "workspace" ? "" : "px-4 sm:px-6";
}

/**
 * The only page wrapper (P1): width, padding and scroll owner.
 *
 * The padding sits OUTSIDE the width cap, on the same element in header and
 * body, so the heading and the first row of content begin on one line. There
 * is no border between header and body — a tab bar, where there is one, is
 * the only divider.
 */
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
  /** `content` hands the scroll to the body (a table owns its viewport); `page` scrolls the whole body. */
  scroll: "content" | "page";
  testId: string;
  surface?: PageSurface;
  /** The page's `PageHeader`. */
  header: ReactNode;
  /** Search and filters that narrow what the body shows. */
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

/**
 * Chat's reading column, the one exception to §4: transcript and composer
 * stand centred in a narrow column beside the conversation list, because a
 * conversation is read, not scanned against a header.
 */
export const READING_COLUMN = "mx-auto w-full max-w-3xl";
