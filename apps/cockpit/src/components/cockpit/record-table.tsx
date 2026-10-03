import type { RowData, SortingState } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { type CockpitColumn, DataTable, type InfiniteRows } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

/**
 * A record's own short list — its runs, steps, approvals, workflows — as the
 * one table (P6), with the labels every such list shares. An engine-paged
 * list hands its `infinite` rows from `useInfiniteList`; a short one shows
 * every row it has.
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
  infinite,
  total,
  getRowId,
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
  infinite?: InfiniteRows;
  total?: number;
  getRowId?(row: TData): string;
}) {
  const { t } = useI18n();
  return (
    <DataTable
      columns={columns}
      data={data}
      sorting={[] as SortingState}
      onSortingChange={() => {}}
      onOpen={onOpen}
      rowHref={rowHref}
      rowLabel={rowLabel}
      rowActions={rowActions}
      linkColumn={linkColumn}
      toolbar={toolbar}
      pending={pending}
      infinite={infinite}
      total={total}
      getRowId={getRowId}
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
      columnsLabel={t("catalog.columns")}
      recordsLabel={t("catalog.records")}
      actionsLabel={t("common.actions")}
      collectionId={collectionId}
      collectionTier="embedded"
    />
  );
}
