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
  RefreshCw,
  Search,
} from "lucide-react";
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";
import { absolute } from "@/app/links";
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
import { Input } from "@/components/ui/input";
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
  /** The cell renders `<RowName>` itself instead of being wrapped whole in the row's link. */
  ownsRowLink?: boolean;
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
  /**
   * Nothing exists yet. The description is the concrete next step where one
   * exists and absent otherwise — a sentence that only restates the title
   * ("records appear here") is filler, not guidance.
   */
  zero: { title: string; description?: string; action?: ReactNode };
  /** Things exist, the current filters exclude them all. */
  filtered: {
    title: string;
    description: string;
    resetLabel: string;
    onReset(): void;
  };
}

const SKELETON_ROWS = 8;

/** The naming cell: wrapped whole in the row's link, or handing the link to its `<RowName>`. */
function LinkedCell({
  owns,
  target,
  children,
}: {
  owns: boolean;
  target: RowLinkTarget;
  children: ReactNode;
}) {
  return owns ? (
    <RowLinkContext.Provider value={target}>{children}</RowLinkContext.Provider>
  ) : (
    <RowLink {...target}>{children}</RowLink>
  );
}

/**
 * Whether a click on a row was meant for something inside it. The whole row
 * opens its record as a convenience; a click on a link, a button or a field in
 * one of its cells belongs to that control, and opening the record on top of
 * it would do two things at once.
 */
const INTERACTIVE =
  'a, button, input, select, textarea, label, summary, [role="menuitem"], [role="checkbox"], [role="combobox"]';

function fromInteractive(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const control = target.closest(INTERACTIVE);
  return control !== null && event.currentTarget.contains(control);
}

/** A plain left click stays in the page; a modified or middle click is the browser's. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

interface RowLinkTarget {
  href: string | null;
  onOpen: () => void;
  testId: string;
}

const RowLinkContext = createContext<RowLinkTarget | null>(null);

/**
 * The row's name as its link, for a cell that holds more than the name (a
 * workflow's name above its health line, which links to its failed runs). A
 * link inside a link is not a link a browser can follow, so such a cell says
 * which part names the row. Outside a row that opens anything it is the name.
 */
export function RowName({ children }: { children: ReactNode }) {
  const target = useContext(RowLinkContext);
  return target ? <RowLink {...target}>{children}</RowLink> : children;
}

/**
 * The one way into a row's record: its name, as a real link.
 *
 * A link, not a button, and not a named "Öffnen" beside the row: the name is
 * what a reader looks for, a link is what the keyboard, a screen reader and
 * "open in new tab" already understand, and a second control beside it that
 * leads to the same place is the duplicate this replaces. A plain click stays
 * in the single-page app (`onOpen`); anything else is the browser's.
 *
 * A record without an address of its own (an audit entry opens in place)
 * keeps the same place and the same keyboard reach, as a button.
 */
function RowLink({
  href,
  onOpen,
  testId,
  children,
}: {
  href: string | null;
  onOpen: () => void;
  testId: string;
  children: ReactNode;
}) {
  const className =
    "min-w-0 rounded-sm text-left font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  if (href)
    return (
      <a
        href={absolute(href)}
        className={className}
        data-testid={testId}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onOpen();
        }}
      >
        {children}
      </a>
    );
  return (
    <button type="button" className={className} data-testid={testId} onClick={onOpen}>
      {children}
    </button>
  );
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  sorting,
  onSortingChange,
  onOpen,
  rowHref,
  linkColumn,
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
  rowActions,
  collectionId = "data-table",
  collectionTier = "primary",
  searchLabel = "Tabelle durchsuchen",
  searchText = (row) => JSON.stringify(row) ?? "",
  showDefaultSearch,
}: {
  columns: CockpitColumn<TData>[];
  data: TData[];
  sorting: SortingState;
  onSortingChange(value: SortingState): void;
  /** Omitted where a row has nowhere to go: no link, no cursor, no row click. */
  onOpen?(row: TData): void;
  /**
   * The row's own address (router-relative, from a `links.ts` builder), which
   * makes its name cell a real link. Null or absent where the record opens in
   * place and has no address; the name is then a button.
   */
  rowHref?(row: TData): string | null;
  /** The column whose cell names the row and carries its link. Defaults to the first. */
  linkColumn?: string;
  /** Search, filters and the column picker in one strip above the table. */
  toolbar?: ReactNode;
  /** Refreshing is an action on the rows, so it lives in the row-action column. */
  onRefresh?(): void;
  refreshing?: boolean;
  refreshLabel?: string;
  /** Row-level actions — further acts on the row, never a second way into it. */
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
  collectionId?: string;
  collectionTier?: "primary" | "embedded";
  searchLabel?: string;
  searchText?: (row: TData) => string;
  /** Use the shared search unless the page toolbar already owns a domain search. */
  showDefaultSearch?: boolean;
}) {
  const searchInputId = useId();
  const [queryText, setQueryText] = useState("");
  const filteredData = useMemo(() => {
    const needle = queryText.trim().toLocaleLowerCase();
    if (!needle || collectionTier === "embedded") return data;
    return data.filter((row) => searchText(row).toLocaleLowerCase().includes(needle));
  }, [collectionTier, data, queryText, searchText]);
  const table = useTable(
    {
      features: cockpitTableFeatures,
      columns,
      data: filteredData,
      state: { sorting },
      manualSorting: true,
      onSortingChange: (updater) => onSortingChange(functionalUpdate(updater, sorting)),
    },
    (state) => ({
      sorting: state.sorting,
      columnVisibility: state.columnVisibility,
    }),
  );
  const visibleColumns = table.getAllLeafColumns().filter((column) => column.getIsVisible());
  // The action column exists only for something to put in it: row actions, or
  // the refresh in its head. A column that held a lone "Öffnen" per row is gone.
  const hasActionColumn = Boolean(rowActions) || Boolean(onRefresh && refreshLabel);
  const bodySpan = visibleColumns.length + (hasActionColumn ? 1 : 0);
  // A reader can hide the naming column; the link then moves to the first
  // column still shown rather than leaving the row without one.
  const linkColumnId = visibleColumns.some((column) => column.id === linkColumn)
    ? linkColumn
    : visibleColumns[0]?.id;
  const rows = table.getRowModel().rows;
  const offsetTotal = queryText.trim() ? filteredData.length : (total ?? data.length);
  const firstRecord = offsetTotal === 0 ? 0 : page * pageSize + 1;
  const lastRecord = Math.min(offsetTotal, (page + 1) * pageSize);
  const canPrevious = page > 0;
  const canNext = mode === "cursor" ? Boolean(hasNext) : lastRecord < offsetTotal;
  const empty = !pending && !error && rows.length === 0;
  const emptyCopy = hasActiveFilters ? emptyState.filtered : emptyState.zero;
  const usesDefaultSearch = collectionTier === "primary" && (showDefaultSearch ?? !toolbar);

  const stateBlock = pending ? null : error ? (
    <div
      className="grid justify-items-center gap-2 py-10 text-center"
      role="alert"
      data-family-slot="data-state"
      data-family-state="error"
    >
      <p className="text-sm font-medium text-destructive">{error.title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{error.description}</p>
      <Button
        variant="outline"
        size="sm"
        data-testid={`${collectionId}-retry`}
        onClick={error.onRetry}
      >
        {error.retryLabel}
      </Button>
    </div>
  ) : (
    <div
      className="grid justify-items-center gap-2 py-10 text-center"
      data-testid={`${collectionId}-empty`}
      data-family-slot="data-state"
      data-family-state="empty"
    >
      <p className="text-sm font-medium">{emptyCopy.title}</p>
      {emptyCopy.description ? (
        <p className="max-w-md text-sm text-muted-foreground">{emptyCopy.description}</p>
      ) : null}
      {hasActiveFilters ? (
        <Button
          variant="outline"
          size="sm"
          data-testid={`${collectionId}-reset-filters`}
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
      data-testid={`${collectionId}`}
      data-family-slot="list-surface"
      data-family-list-kind="table"
      data-family-collection-id={collectionId}
      data-family-collection-tier={collectionTier}
      data-family-collection-capability={
        collectionTier === "primary"
          ? "search relevant-filters sort column-visibility result-count pagination url-state responsive-cards loading-state empty-state error-state"
          : "sort responsive-cards loading-state empty-state error-state"
      }
      data-family-state={pending ? "loading" : error ? "error" : empty ? "empty" : "ready"}
      aria-busy={pending ? true : undefined}
    >
      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        data-family-slot="list-toolbar"
      >
        {usesDefaultSearch && (
          <label htmlFor={searchInputId} className="relative min-w-52 flex-1 sm:max-w-xs">
            <span className="sr-only">{searchLabel}</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={searchInputId}
              type="search"
              value={queryText}
              onChange={(event) => {
                setQueryText(event.target.value);
                onPageChange(0);
              }}
              placeholder={searchLabel}
              className="pl-8"
              data-family-action="search"
              data-testid={`${collectionId}-search`}
            />
          </label>
        )}
        {toolbar}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="ms-auto"
              data-testid={`${collectionId}-columns`}
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
        data-testid={`${collectionId}-desktop`}
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
                          data-testid={`${collectionId}-sort-${header.column.id}`}
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
                {hasActionColumn ? (
                  <TableHead className={rowActions ? "w-32" : "w-16"}>
                    <span className="flex items-center justify-end">
                      <span className="sr-only">{actionsLabel}</span>
                      {onRefresh && refreshLabel && (
                        <IconButton
                          variant="ghost"
                          size="icon-sm"
                          label={refreshLabel}
                          data-testid={`${collectionId}-refresh`}
                          onClick={onRefresh}
                        >
                          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
                        </IconButton>
                      )}
                    </span>
                  </TableHead>
                ) : null}
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
                <TableRow key={rowIndex} data-testid={`${collectionId}-skeleton-row-${rowIndex}`}>
                  {visibleColumns.map((column) => (
                    <TableCell key={column.id}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                  {hasActionColumn ? (
                    <TableCell>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            ) : error || empty ? (
              <TableRow>
                <TableCell colSpan={bodySpan}>{stateBlock}</TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => {
                const open = onOpen ? () => onOpen(row.original) : null;
                return (
                  <TableRow
                    key={row.id}
                    data-family-slot="list-row"
                    data-family-collection-row="true"
                    className={open ? "cursor-pointer" : undefined}
                    data-testid={`${collectionId}-row-${index}`}
                    // The whole row is a convenience for the pointer. The
                    // keyboard and the screen reader reach the record through
                    // the link in its name cell, so the row is no tab stop.
                    onClick={
                      open
                        ? (event) => {
                            if (fromInteractive(event)) return;
                            open();
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {open && cell.column.id === linkColumnId ? (
                          <LinkedCell
                            owns={Boolean(cell.column.columnDef.meta?.ownsRowLink)}
                            target={{
                              href: rowHref?.(row.original) ?? null,
                              onOpen: open,
                              testId: `${collectionId}-row-link-${index}`,
                            }}
                          >
                            <table.FlexRender cell={cell} />
                          </LinkedCell>
                        ) : (
                          <table.FlexRender cell={cell} />
                        )}
                      </TableCell>
                    ))}
                    {hasActionColumn ? (
                      <TableCell>
                        <span className="flex items-center justify-end gap-1">
                          {rowActions?.(row.original, index)}
                        </span>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto md:hidden"
        data-testid={`${collectionId}-mobile`}
      >
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
              const open = onOpen ? () => onOpen(row.original) : null;
              // Three facts fit a 390px card; a seven-column table does not.
              // The naming cell leads the card and carries its link; the card
              // itself is not a button, because it holds links of its own.
              const all = row.getVisibleCells();
              const named = open ? all.find((cell) => cell.column.id === linkColumnId) : undefined;
              const cells = (named ? [named, ...all.filter((cell) => cell !== named)] : all).slice(
                0,
                3,
              );
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
                    {open && cell === named ? (
                      <LinkedCell
                        owns={Boolean(cell.column.columnDef.meta?.ownsRowLink)}
                        target={{
                          href: rowHref?.(row.original) ?? null,
                          onOpen: open,
                          testId: `${collectionId}-mobile-row-link-${index}`,
                        }}
                      >
                        <table.FlexRender cell={cell} />
                      </LinkedCell>
                    ) : (
                      <table.FlexRender cell={cell} />
                    )}
                  </span>
                </span>
              ));
              const actions = rowActions?.(row.original, index);
              return (
                // The keyboard and the screen reader reach the record through
                // the link in the card's title; the click on the rest of the
                // card is a pointer convenience, as on the desktop row.
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is the title link
                // biome-ignore lint/a11y/noStaticElementInteractions: the card holds links of its own and must not be a button
                <div
                  key={row.id}
                  className={cn(
                    "flex min-w-0 flex-col gap-3 p-4 text-left",
                    open && "cursor-pointer",
                  )}
                  onClick={
                    open
                      ? (event) => {
                          if (fromInteractive(event)) return;
                          open();
                        }
                      : undefined
                  }
                  data-testid={`${collectionId}-mobile-row-${index}`}
                  data-family-slot="list-row"
                  data-family-collection-row="true"
                  data-family-collection-mobile-card="true"
                >
                  {card}
                  {actions ? <span className="flex justify-end gap-1">{actions}</span> : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <footer
        className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2"
        data-family-slot="pagination"
      >
        <span
          className="text-xs text-muted-foreground"
          data-family-slot="collection-meta"
          data-family-result-count
        >
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
            data-testid={`${collectionId}-previous`}
          >
            <ChevronLeft data-icon="inline-start" />
            {previousLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canNext}
            onClick={() => onPageChange(page + 1)}
            data-testid={`${collectionId}-next`}
          >
            {nextLabel}
            <ChevronRight data-icon="inline-end" />
          </Button>
        </div>
      </footer>
    </div>
  );
}
