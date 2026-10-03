import type { RowData, SortingState } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { type CockpitColumn, DataTable } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

/**
 * A short list a page holds in full — keys, apps, rules, channels: the
 * `DataTable` without paging, sorting or a search of its own, with the
 * table's labels filled in once. Each table is its own action scope, so two
 * of them on one view may each offer their column picker.
 */
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
}: {
  id: string;
  columns: CockpitColumn<TData>[];
  rows: TData[];
  pending: boolean;
  failed: boolean;
  /** What did not load, for "{Was} konnte nicht geladen werden." */
  resource: string;
  onRetry(): void;
  /** "Noch keine {Objekte}." */
  empty: string;
  emptyAction?: ReactNode;
  onOpen?(row: TData): void;
  rowLabel?(row: TData): string;
  rowActions?: (row: TData, index: number) => ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="overflow-hidden rounded-xl border" data-action-scope="table">
      <DataTable
        collectionId={id}
        collectionTier="embedded"
        columns={columns}
        data={rows}
        onOpen={onOpen}
        rowLabel={rowLabel}
        rowActions={rowActions}
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
            onReset: onRetry,
          },
        }}
        hasActiveFilters={false}
        sorting={[] as SortingState}
        onSortingChange={() => {}}
        page={0}
        pageSize={Math.max(rows.length, 1)}
        total={rows.length}
        onPageChange={() => {}}
        previousLabel={t("catalog.previous")}
        nextLabel={t("catalog.next")}
        columnsLabel={t("catalog.columns")}
        recordsLabel={t("catalog.records")}
        loadedLabel={t("catalog.loaded", { count: rows.length })}
        actionsLabel={t("common.actions")}
      />
    </div>
  );
}
