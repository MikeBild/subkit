import type { RowData, SortingState } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { type CockpitColumn, DataTable } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

export function ListTable<TData extends RowData>({
  id,
  columns,
  rows,
  pending,
  failed,
  resource,
  onRetry,
  empty,
  emptyAction,
  onOpen,
  rowLabel,
  rowActions,
  layout,
  toolbar,
  groupingTabs,
  grouping,
  hasActiveFilters = false,
  onReset = onRetry,
}: {
  id: string;
  columns: CockpitColumn<TData>[];
  rows: TData[];
  pending: boolean;
  failed: boolean;
  resource: string;
  onRetry(): void;
  empty: string;
  emptyAction?: ReactNode;
  onOpen?(row: TData): void;
  rowLabel?(row: TData): string;
  rowActions?: (row: TData, index: number) => ReactNode;
  layout?: "responsive" | "rows";
  toolbar?: ReactNode;
  groupingTabs?: ReactNode;
  grouping?: { getKey(row: TData): string; label?(key: string): string };
  hasActiveFilters?: boolean;
  onReset?(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="overflow-hidden rounded-xl border" data-action-scope="table">
      <DataTable
        collectionId={id}
        collectionTier="embedded"
        layout={layout}
        columns={columns}
        data={rows}
        onOpen={onOpen}
        rowLabel={rowLabel}
        rowActions={rowActions}
        toolbar={toolbar}
        groupingTabs={groupingTabs}
        grouping={grouping}
        pending={pending}
        error={
          failed
            ? {
                title: t("resource.loadFailed", { resource }),
                description: t("resource.loadFailedDescription"),
                retryLabel: t("session.retry"),
                onRetry,
              }
            : null
        }
        emptyState={{
          zero: { title: empty, action: emptyAction },
          filtered: {
            title: t("resource.noMatches"),
            description: t("resource.broaderSearch"),
            resetLabel: t("catalog.clearFilters"),
            onReset,
          },
        }}
        hasActiveFilters={hasActiveFilters}
        sorting={[] as SortingState}
        onSortingChange={() => {}}
        total={rows.length}
        columnsLabel={t("catalog.columns")}
        recordsLabel={t("catalog.records")}
        actionsLabel={t("common.actions")}
      />
    </div>
  );
}
