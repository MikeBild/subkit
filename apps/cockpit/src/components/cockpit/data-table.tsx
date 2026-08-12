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
} from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const cockpitTableFeatures = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
});

export type CockpitTableFeatures = typeof cockpitTableFeatures;
export type CockpitColumn<TData extends RowData> = ColumnDef<CockpitTableFeatures, TData>;

export function DataTable<TData extends RowData>({
  columns,
  data,
  sorting,
  onSortingChange,
  onOpen,
  page,
  pageSize,
  total,
  onPageChange,
  previousLabel,
  nextLabel,
  columnsLabel,
  recordsLabel,
  actionsLabel,
  openLabel,
}: {
  columns: CockpitColumn<TData>[];
  data: TData[];
  sorting: SortingState;
  onSortingChange(value: SortingState): void;
  onOpen(row: TData): void;
  page: number;
  pageSize: number;
  total: number;
  onPageChange(page: number): void;
  previousLabel: string;
  nextLabel: string;
  columnsLabel: string;
  recordsLabel: string;
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
  const firstRecord = total === 0 ? 0 : page * pageSize + 1;
  const lastRecord = Math.min(total, (page + 1) * pageSize);
  const canPrevious = page > 0;
  const canNext = lastRecord < total;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-table">
      <div className="flex items-center justify-end border-b px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" data-testid="data-table-columns">
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
          <TableHeader className="sticky top-0 bg-background">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id}>
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
                <TableHead className="w-12">
                  <span className="sr-only">{actionsLabel}</span>
                </TableHead>
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row, index) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                tabIndex={0}
                data-testid={`data-table-row-${index}`}
                onClick={() => onOpen(row.original)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onOpen(row.original);
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
                <TableCell>
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="grid divide-y md:hidden" data-testid="data-table-mobile">
        {table.getRowModel().rows.map((row, index) => {
          const cells = row.getVisibleCells().slice(0, 4);
          return (
            <button
              key={row.id}
              type="button"
              className="flex min-w-0 flex-col gap-3 p-4 text-left"
              onClick={() => onOpen(row.original)}
              data-testid={`data-table-mobile-row-${index}`}
            >
              {cells.map((cell, cellIndex) => (
                <span key={cell.id} className="flex min-w-0 items-start justify-between gap-4">
                  <span className="text-xs text-muted-foreground">
                    {typeof cell.column.columnDef.header === "string"
                      ? cell.column.columnDef.header
                      : cell.column.id}
                  </span>
                  <span className={cellIndex === 0 ? "truncate font-medium" : "text-right text-sm"}>
                    <table.FlexRender cell={cell} />
                  </span>
                </span>
              ))}
            </button>
          );
        })}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {recordsLabel}: {firstRecord}–{lastRecord} / {total}
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
