import {
  type ColumnDef,
  columnVisibilityFeature,
  functionalUpdate,
  type RowData,
  rowSortingFeature,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/cockpit/icon-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** A column states its own width; that is what keeps the table `table-fixed`. */
export interface CockpitColumnMeta {
  width?: string;
}

export const cockpitTableFeatures = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
  columnMeta: {} as CockpitColumnMeta,
});

export type CockpitTableFeatures = typeof cockpitTableFeatures;
export type CockpitColumn<TData extends RowData> = ColumnDef<CockpitTableFeatures, TData>;

export interface TableErrorState {
  title: string;
  description: string;
  retryLabel: string;
  onRetry(): void;
}

export interface TableEmptyState {
  /** Nothing exists yet. */
  zero: { title: string; description: string; action?: ReactNode };
  /** Things exist, the current filters exclude them all. */
  filtered: { title: string; description: string; resetLabel: string; onReset(): void };
}

const SKELETON_ROWS = 8;

export function DataTable<TData extends RowData>({
  columns,
  data,
  sorting,
  onSortingChange,
  onOpen,
  toolbar,
  onRefresh,
  refreshing,
  refreshLabel,
  pending,
  error,
  emptyState,
  hasActiveFilters,
  mode = "offset",
  page,
  pageSize,
  total,
  hasNext,
  onPageChange,
  previousLabel,
  nextLabel,
  columnsLabel,
  recordsLabel,
  loadedLabel,
  actionsLabel,
  openLabel,
  rowActions,
}: {
  columns: CockpitColumn<TData>[];
  data: TData[];
  sorting: SortingState;
  onSortingChange(value: SortingState): void;
  /** Omitted where a row has nowhere to go: no cursor, no key handler, no open button. */
  onOpen?(row: TData): void;
  /** Search, filters and the column picker in one strip above the table. */
  toolbar?: ReactNode;
  /** Refreshing is an action on the rows, so it lives in the row-action column. */
  onRefresh?(): void;
  refreshing?: boolean;
  refreshLabel?: string;
  /** Row-level actions rendered next to the open button, e.g. an inline picker. */
  rowActions?: (row: TData, index: number) => ReactNode;
  pending?: boolean;
  error?: TableErrorState | null;
  emptyState: TableEmptyState;
  hasActiveFilters: boolean;
  /**
   * `offset` knows the total and counts `x–y / total`; `cursor` does not and
   * never invents one — it says how many rows are loaded and offers the step.
   */
  mode?: "offset" | "cursor";
  page: number;
  pageSize: number;
  total?: number;
  hasNext?: boolean;
  onPageChange(page: number): void;
  previousLabel: string;
  nextLabel: string;
  columnsLabel: string;
  recordsLabel: string;
  loadedLabel: string;
  actionsLabel: string;
  openLabel: string;
}) {
  const table = useTable(
    {
      features: cockpitTableFeatures,
      columns,
      data,
      state: { sorting },
      manualSorting: true,
      onSortingChange: (updater) => onSortingChange(functionalUpdate(updater, sorting)),
    },
    (state) => ({ sorting: state.sorting, columnVisibility: state.columnVisibility }),
  );
  const visibleColumns = table.getAllLeafColumns().filter((column) => column.getIsVisible());
  const bodySpan = visibleColumns.length + 1;
  const rows = table.getRowModel().rows;
  const offsetTotal = total ?? data.length;
  const firstRecord = offsetTotal === 0 ? 0 : page * pageSize + 1;
  const lastRecord = Math.min(offsetTotal, (page + 1) * pageSize);
  const canPrevious = page > 0;
  const canNext = mode === "cursor" ? Boolean(hasNext) : lastRecord < offsetTotal;
  const empty = !pending && !error && rows.length === 0;
  const emptyCopy = hasActiveFilters ? emptyState.filtered : emptyState.zero;

  const stateBlock = pending ? null : error ? (
    <div
      className="grid justify-items-center gap-2 py-10 text-center"
      role="alert"
      data-family-slot="data-state"
      data-family-state="error"
    >
      <p className="text-sm font-medium text-destructive">{error.title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{error.description}</p>
      <Button variant="outline" size="sm" data-testid="data-table-retry" onClick={error.onRetry}>
        {error.retryLabel}
      </Button>
    </div>
  ) : (
    <div
      className="grid justify-items-center gap-2 py-10 text-center"
      data-testid="data-table-empty"
      data-family-slot="data-state"
      data-family-state="empty"
    >
      <p className="text-sm font-medium">{emptyCopy.title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{emptyCopy.description}</p>
      {hasActiveFilters ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="data-table-reset-filters"
          onClick={emptyState.filtered.onReset}
        >
          {emptyState.filtered.resetLabel}
        </Button>
      ) : (
        emptyState.zero.action
      )}
    </div>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="data-table"
      data-family-slot="list-surface"
      data-family-list-kind="table"
      data-family-state={pending ? "loading" : error ? "error" : empty ? "empty" : "ready"}
      aria-busy={pending ? true : undefined}
    >
      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        data-family-slot="list-toolbar"
      >
        {toolbar}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="ms-auto"
              data-testid="data-table-columns"
            >
              <Columns3 data-icon="inline-start" />
              {columnsLabel}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{columnsLabel}</DropdownMenuLabel>
            <DropdownMenuGroup>
              {table
                .getAllLeafColumns()
                .filter((column) => column.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(checked) => column.toggleVisibility(Boolean(checked))}
                  >
                    {typeof column.columnDef.header === "string"
                      ? column.columnDef.header
                      : column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        className="hidden min-h-0 flex-1 overflow-auto md:block"
        data-testid="data-table-desktop"
      >
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id} className={header.column.columnDef.meta?.width}>
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-2"
                          onClick={header.column.getToggleSortingHandler()}
                          data-testid={`data-table-sort-${header.column.id}`}
                        >
                          <table.FlexRender header={header} />
                          {sorted === "asc" ? (
                            <ArrowUp data-icon="inline-end" />
                          ) : sorted === "desc" ? (
                            <ArrowDown data-icon="inline-end" />
                          ) : (
                            <ArrowUpDown data-icon="inline-end" />
                          )}
                        </Button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  );
                })}
                <TableHead className="w-24">
                  <span className="flex items-center justify-end">
                    <span className="sr-only">{actionsLabel}</span>
                    {onRefresh && refreshLabel && (
                      <IconButton
                        variant="ghost"
                        size="icon-sm"
                        label={refreshLabel}
                        data-testid="data-table-refresh"
                        onClick={onRefresh}
                      >
                        <RefreshCw className={refreshing ? "animate-spin" : undefined} />
                      </IconButton>
                    )}
                  </span>
                </TableHead>
              </TableRow>
            ))}
          </TableHeader>
          <TableBody
            data-family-slot={pending ? "data-state" : undefined}
            data-family-state={pending ? "loading" : undefined}
            aria-busy={pending ? true : undefined}
          >
            {pending ? (
              Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
                <TableRow key={rowIndex} data-testid={`data-table-skeleton-row-${rowIndex}`}>
                  {visibleColumns.map((column) => (
                    <TableCell key={column.id}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                  <TableCell>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : error || empty ? (
              <TableRow>
                <TableCell colSpan={bodySpan}>{stateBlock}</TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => (
                <TableRow
                  key={row.id}
                  data-family-slot="list-row"
                  className={onOpen ? "cursor-pointer" : undefined}
                  tabIndex={onOpen ? 0 : undefined}
                  data-testid={`data-table-row-${index}`}
                  onClick={onOpen ? () => onOpen(row.original) : undefined}
                  onKeyDown={
                    onOpen
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") onOpen(row.original);
                        }
                      : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                  <TableCell>
                    <span className="flex items-center justify-end gap-1">
                      {rowActions?.(row.original, index)}
                      {onOpen && (
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          label={openLabel}
                          data-testid={`data-table-open-${index}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpen(row.original);
                          }}
                        >
                          <MoreHorizontal />
                        </IconButton>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto md:hidden" data-testid="data-table-mobile">
        {pending ? (
          <div
            className="grid gap-3 p-4"
            role="status"
            data-family-slot="data-state"
            data-family-state="loading"
            aria-busy="true"
          >
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : error || empty ? (
          <div className="p-4">{stateBlock}</div>
        ) : (
          <div className="grid divide-y">
            {rows.map((row, index) => {
              // Three facts fit a 390px card; a seven-column table does not.
              const cells = row.getVisibleCells().slice(0, 3);
              const card = cells.map((cell, cellIndex) => (
                <span key={cell.id} className="flex min-w-0 items-start justify-between gap-4">
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {typeof cell.column.columnDef.header === "string"
                      ? cell.column.columnDef.header
                      : cell.column.id}
                  </span>
                  {/* The value wraps rather than running off the card. A 390px
                      card cannot hold a long workflow name on one line, and
                      `truncate` alone clipped it mid-word with no ellipsis
                      because the span had no width to truncate against. */}
                  <span
                    className={cn(
                      "min-w-0 flex-1 break-words text-right",
                      cellIndex === 0 ? "font-medium" : "text-sm",
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </span>
                </span>
              ));
              // A row with nowhere to go is read, not pressed.
              return onOpen ? (
                <button
                  key={row.id}
                  type="button"
                  className="flex min-w-0 flex-col gap-3 p-4 text-left"
                  onClick={() => onOpen(row.original)}
                  data-testid={`data-table-mobile-row-${index}`}
                  data-family-slot="list-row"
                >
                  {card}
                </button>
              ) : (
                <div
                  key={row.id}
                  className="flex min-w-0 flex-col gap-3 p-4 text-left"
                  data-testid={`data-table-mobile-row-${index}`}
                  data-family-slot="list-row"
                >
                  {card}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {mode === "cursor"
            ? loadedLabel
            : `${recordsLabel}: ${firstRecord}–${lastRecord} / ${offsetTotal}`}
        </span>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{page + 1}</Badge>
          <Button
            variant="outline"
            size="sm"
            disabled={!canPrevious}
            onClick={() => onPageChange(page - 1)}
            data-testid="data-table-previous"
          >
            <ChevronLeft data-icon="inline-start" />
            {previousLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canNext}
            onClick={() => onPageChange(page + 1)}
            data-testid="data-table-next"
          >
            {nextLabel}
            <ChevronRight data-icon="inline-end" />
          </Button>
        </div>
      </footer>
    </div>
  );
}
