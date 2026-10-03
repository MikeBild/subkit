import type { RowData, SortingState } from "@tanstack/react-table";
import { type ReactNode, useState } from "react";
import { type CockpitColumn, DataTable } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

/**
 * A record's own short list — its runs, steps, approvals, workflows — as the
 * one table (P6), with the labels and the paging every such list shares. The
 * rows are already read; they are paged here, not by the engine, unless the
 * caller pages them (`paging`).
 */
export function RecordTable<TData extends RowData>({
  columns,
  data,
  collectionId,
  emptyLine,
  emptyAction,
  pending,
  error,
  onOpen,
  rowHref,
  rowLabel,
  rowActions,
  linkColumn,
  toolbar,
  pageSize = 10,
  paging,
}: {
  columns: CockpitColumn<TData>[];
  data: TData[];
  collectionId: string;
  /** "Noch keine {Objekte}." */
  emptyLine: string;
  emptyAction?: ReactNode;
  pending?: boolean;
  /** What did not load, and how to read it again. */
  error?: { line: string; onRetry(): void } | null;
  onOpen?(row: TData): void;
  rowHref?(row: TData): string | null;
  rowLabel?(row: TData): string;
  rowActions?: (row: TData, index: number) => ReactNode;
  linkColumn?: string;
  toolbar?: ReactNode;
  pageSize?: number;
  /** The engine pages the rows: `data` is the current page. */
  paging?: {
    page: number;
    onPageChange(page: number): void;
    total?: number;
    hasNext?: boolean;
  };
}) {
  const { t } = useI18n();
  const [ownPage, setOwnPage] = useState(0);
  const page = paging?.page ?? ownPage;
  const rows = paging ? data : data.slice(ownPage * pageSize, (ownPage + 1) * pageSize);
  const cursor = paging !== undefined && paging.total === undefined;
  return (
    <DataTable
      columns={columns}
      data={rows}
      sorting={[] as SortingState}
      onSortingChange={() => {}}
      onOpen={onOpen}
      rowHref={rowHref}
      rowLabel={rowLabel}
      rowActions={rowActions}
      linkColumn={linkColumn}
      toolbar={toolbar}
      pending={pending}
      error={
        error
          ? {
              title: error.line,
              description: "",
              retryLabel: t("pattern.retry"),
              onRetry: error.onRetry,
            }
          : null
      }
      emptyState={{
        zero: { title: emptyLine, action: emptyAction },
        filtered: {
          title: t("resource.noMatches"),
          description: t("resource.broaderSearch"),
          resetLabel: t("catalog.clearFilters"),
          onReset: () => {},
        },
      }}
      hasActiveFilters={false}
      mode={cursor ? "cursor" : "offset"}
      page={page}
      pageSize={pageSize}
      total={paging ? paging.total : data.length}
      hasNext={paging?.hasNext}
      onPageChange={paging ? paging.onPageChange : setOwnPage}
      previousLabel={t("catalog.previous")}
      nextLabel={t("catalog.next")}
      columnsLabel={t("catalog.columns")}
      recordsLabel={t("catalog.records")}
      loadedLabel={t("catalog.loaded", { count: data.length })}
      actionsLabel={t("common.actions")}
      collectionId={collectionId}
      collectionTier="embedded"
    />
  );
}
