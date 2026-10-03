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
  ChevronRight,
  Columns3,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { absolute } from "@/app/links";
import { IconButton } from "@/components/cockpit/icon-button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/lib/i18n-context";
import { useArrived, useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";
import { DataState, LOADING_ROWS } from "./data-state";
import { useRowMotion } from "./row-motion";
import { Skeleton } from "./skeleton";

/** A column states its own width; that is what keeps the table `table-fixed`. */
export interface CockpitColumnMeta {
  width?: string;
  /** The cell renders `<RowName>` itself instead of being wrapped whole in the row's link. */
  ownsRowLink?: boolean;
  /** The cell holds links or controls of its own (relations, chips). */
  interactive?: boolean;
  /**
   * `low`: a column a narrower table can do without. It is left out while the
   * list itself is narrower than 56rem — measured on the list, not the window,
   * because the sidebar takes a third of a tablet — so the columns that matter
   * fit; the column picker still lists it. Below 42rem the list shows cards.
   */
  priority?: "high" | "low";
}

/** The class a column's head and cells take for its priority. */
export function priorityClass(priority: CockpitColumnMeta["priority"]): string | undefined {
  return priority === "low" ? "hidden @4xl:table-cell" : undefined;
}

/** The next page of an endless list: what `useInfiniteQuery` hands back. */
export interface InfiniteRows {
  fetchNextPage(): unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

/**
 * Loads the next page as the end of the list comes near: a sentinel row just
 * past the last one, watched by an IntersectionObserver on the list's own
 * scroll container. A button stays for the keyboard and for a page too short
 * to scroll.
 */
function InfiniteSentinel({
  infinite,
  testId,
  className,
}: {
  infinite: InfiniteRows;
  testId: string;
  className?: string;
}) {
  const { t } = useI18n();
  const sentinel = useRef<HTMLDivElement>(null);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = infinite;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage)
          void fetchNextPage();
      },
      { rootMargin: "0px 0px 320px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  if (!hasNextPage && !isFetchingNextPage) return null;
  return (
    <div
      ref={sentinel}
      className={cn(
        "flex h-11 items-center justify-center text-sm text-muted-foreground",
        className,
      )}
      data-slot="infinite-sentinel"
      data-testid={testId}
    >
      {isFetchingNextPage ? (
        <span role="status" className="inline-flex items-center gap-2">
          <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          {t("platform.loadingMore")}
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void fetchNextPage()}
          data-testid={`${testId ?? "data-table"}-load-more`}
        >
          {t("platform.loadMore")}
        </Button>
      )}
    </div>
  );
}

const SKELETON_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-1/3", "w-2/5"] as const;

/**
 * Which visible column names the row and carries its link.
 *
 * The preferred column while it is shown. A reader can hide it; the link then
 * moves only to a column that holds no link of its own — wrapping a relation
 * chip in the row's link would nest one link in another, which no browser can
 * follow. With no such column the row has no link, and still opens on click.
 */
export function rowLinkColumn(
  visible: readonly { id: string; interactive?: boolean; ownsRowLink?: boolean }[],
  preferred?: string,
): string | undefined {
  const chosen = visible.find((column) => column.id === (preferred ?? visible[0]?.id));
  if (chosen && (!chosen.interactive || chosen.ownsRowLink)) return chosen.id;
  return visible.find((column) => !column.interactive)?.id;
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
  /** The accessible name, where the cell's text alone does not say which record. */
  label?: string;
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
  label,
  children,
}: {
  href: string | null;
  onOpen: () => void;
  testId: string;
  label?: string;
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
        aria-label={label}
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
    <button
      type="button"
      className={className}
      data-testid={testId}
      aria-label={label}
      onClick={onOpen}
    >
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
  rowLabel,
  linkColumn,
  toolbar,
  onRefresh,
  refreshing,
  refreshLabel,
  pending,
  error,
  emptyState,
  hasActiveFilters,
  infinite,
  getRowId,
  skeletonRows = LOADING_ROWS,
  total,
  onPageChange,
  columnsLabel,
  recordsLabel,
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
  /**
   * The link's accessible name, where the naming cell alone does not say which
   * record it is — an audit entry's cell is its time.
   */
  rowLabel?(row: TData): string;
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
   * An endless list: the next page loads as the reader nears the end of the
   * rows (`useInfiniteList`). Without it the list shows every row it is given;
   * there is no pager.
   */
  infinite?: InfiniteRows;
  /**
   * A row's stable identity. With it, a row that arrives through a live update
   * washes in with the accent and a row that goes fades out where it stood.
   */
  getRowId?(row: TData): string;
  /** How many placeholder rows stand in while the first rows load. */
  skeletonRows?: number;
  /** The number of records the filters match, where the engine counts them. */
  total?: number;
  /** Called with 0 when the built-in search changes what the list shows. */
  onPageChange?(page: number): void;
  /** @deprecated No pager any more; ignored until every list is endless. */
  mode?: "offset" | "cursor";
  /** @deprecated No pager any more; ignored. */
  page?: number;
  /** @deprecated No pager any more; ignored. */
  pageSize?: number;
  /** @deprecated No pager any more; ignored. */
  hasNext?: boolean;
  /** @deprecated No pager any more; ignored. */
  previousLabel?: string;
  /** @deprecated No pager any more; ignored. */
  nextLabel?: string;
  columnsLabel: string;
  /** The result count's label, for assistive technology. */
  recordsLabel?: string;
  /** @deprecated The result count is stated by the table itself; ignored. */
  loadedLabel?: string;
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
  const { t } = useI18n();
  const phase = useLoadingPhase(Boolean(pending));
  const arrivedContent = useArrived(phase);
  // Rows that just left stay a moment for their fade; they are part of the
  // table's data until then, flagged so they render inert.
  const motion = useRowMotion(filteredData, getRowId, !pending && !error);
  const tableData = useMemo(() => motion.display.map((entry) => entry.row), [motion.display]);
  const leavingAt = (index: number) => motion.display[index]?.leaving === true;
  const rowMotionClass = (row: TData, index: number) =>
    leavingAt(index)
      ? "sk-row-leave pointer-events-none"
      : getRowId && motion.arrived.has(getRowId(row))
        ? "sk-row-new"
        : undefined;
  const table = useTable(
    {
      features: cockpitTableFeatures,
      columns,
      data: tableData,
      ...(getRowId ? { getRowId: (row: TData) => getRowId(row) } : {}),
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
  // A row that opens something ends in a chevron (P6): the name is the link,
  // the chevron says the whole row leads on. There is no "Öffnen" button.
  const hasChevron = Boolean(onOpen);
  const bodySpan = visibleColumns.length + (hasActionColumn ? 1 : 0) + (hasChevron ? 1 : 0);
  // A reader can hide the naming column; the link then moves to the first
  // column still shown rather than leaving the row without one.
  const linkColumnId = rowLinkColumn(
    visibleColumns.map((column) => ({
      id: column.id,
      interactive: column.columnDef.meta?.interactive,
      ownsRowLink: column.columnDef.meta?.ownsRowLink,
    })),
    linkColumn ?? visibleColumns[0]?.id,
  );
  const rows = table.getRowModel().rows;
  // The result count is stated for assistive technology, not drawn: a list
  // shows its rows, and a footer counting them was noise. Where the engine
  // counts the matches it says that number; otherwise the rows shown.
  const resultCount = queryText.trim() ? filteredData.length : (total ?? data.length);
  const showSkeleton = phase !== "content";
  const empty = !showSkeleton && !error && rows.length === 0;
  const emptyCopy = hasActiveFilters ? emptyState.filtered : emptyState.zero;
  const usesDefaultSearch = collectionTier === "primary" && (showDefaultSearch ?? !toolbar);

  // One line and one action (P12). The descriptions the states still carry
  // are not shown: a second paragraph under an empty list was the text wall.
  const stateBlock = pending ? null : error ? (
    <DataState
      state="error"
      line={error.title}
      action={
        <Button
          variant="outline"
          size="sm"
          data-testid={`${collectionId}-retry`}
          onClick={error.onRetry}
        >
          {error.retryLabel}
        </Button>
      }
    />
  ) : (
    <DataState
      state="empty"
      line={emptyCopy.title}
      testId={`${collectionId}-empty`}
      action={
        hasActiveFilters ? (
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
        )
      }
    />
  );

  return (
    <div
      className="@container flex min-h-0 flex-1 flex-col"
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
                onPageChange?.(0);
              }}
              placeholder={searchLabel}
              className="pl-8"
              data-family-action="search"
              data-testid={`${collectionId}-search`}
            />
          </label>
        )}
        {toolbar}
        <span
          className="sr-only"
          aria-live="polite"
          data-family-slot="collection-meta"
          data-family-result-count
          data-testid={`${collectionId}-count`}
        >
          {showSkeleton ? "" : `${recordsLabel ?? t("platform.results")}: ${resultCount}`}
        </span>
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
        className="hidden min-h-0 flex-1 overflow-auto @2xl:block"
        data-testid={`${collectionId}-desktop`}
      >
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        header.column.columnDef.meta?.width,
                        priorityClass(header.column.columnDef.meta?.priority),
                      )}
                    >
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
                {hasChevron ? <TableHead className="w-8" aria-hidden="true" /> : null}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody
            data-family-slot={showSkeleton ? "data-state" : undefined}
            data-family-state={showSkeleton ? "loading" : undefined}
            data-loading-phase={showSkeleton ? phase : undefined}
            aria-busy={showSkeleton ? true : undefined}
            className={arrivedContent ? "sk-fade-in" : undefined}
          >
            {showSkeleton ? (
              // The final rows' shape: one bar per column at the row's height,
              // invisible for the first moments so a fast answer never flashes.
              Array.from({ length: skeletonRows }, (_, rowIndex) => (
                <TableRow
                  key={rowIndex}
                  className={cn(
                    "h-11 hover:bg-transparent",
                    phase === "reserve" ? "invisible" : "sk-fade-in",
                  )}
                  data-testid={`${collectionId}-skeleton-row-${rowIndex}`}
                >
                  {visibleColumns.map((column, columnIndex) => (
                    <TableCell
                      key={column.id}
                      className={priorityClass(column.columnDef.meta?.priority)}
                    >
                      <Skeleton
                        className={cn(
                          "h-4",
                          SKELETON_WIDTHS[(rowIndex + columnIndex) % SKELETON_WIDTHS.length],
                        )}
                      />
                    </TableCell>
                  ))}
                  {hasActionColumn ? <TableCell /> : null}
                  {hasChevron ? <TableCell className="w-8" /> : null}
                </TableRow>
              ))
            ) : error || empty ? (
              <TableRow>
                <TableCell colSpan={bodySpan}>{stateBlock}</TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => {
                const leaving = leavingAt(index);
                const open = onOpen && !leaving ? () => onOpen(row.original) : null;
                return (
                  <TableRow
                    key={row.id}
                    data-family-slot={leaving ? undefined : "list-row"}
                    data-family-collection-row={leaving ? undefined : "true"}
                    aria-hidden={leaving ? true : undefined}
                    className={cn(
                      "h-11",
                      open && "cursor-pointer",
                      rowMotionClass(row.original, index),
                    )}
                    data-testid={leaving ? undefined : `${collectionId}-row-${index}`}
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
                      <TableCell
                        key={cell.id}
                        className={priorityClass(cell.column.columnDef.meta?.priority)}
                      >
                        {open && cell.column.id === linkColumnId ? (
                          <LinkedCell
                            owns={Boolean(cell.column.columnDef.meta?.ownsRowLink)}
                            target={{
                              href: rowHref?.(row.original) ?? null,
                              onOpen: open,
                              testId: `${collectionId}-row-link-${index}`,
                              label: rowLabel?.(row.original),
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
                    {hasChevron ? (
                      <TableCell className="w-8 text-muted-foreground" data-slot="row-chevron">
                        <ChevronRight aria-hidden="true" className="size-4" />
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        {infinite && !showSkeleton && !error ? (
          <InfiniteSentinel infinite={infinite} testId={`${collectionId}-more`} />
        ) : null}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto @2xl:hidden"
        data-testid={`${collectionId}-mobile`}
      >
        {showSkeleton ? (
          // A card's shape: three label/value lines, as many cards as rows.
          <div
            className={cn("grid divide-y", phase === "reserve" ? "invisible" : "sk-fade-in")}
            data-family-slot="data-state"
            data-family-state="loading"
            aria-busy="true"
          >
            {Array.from({ length: skeletonRows }, (_, cardIndex) => (
              <div key={cardIndex} className="flex flex-col gap-3 p-4">
                {[0, 1, 2].map((line) => (
                  <span key={line} className="flex h-5 items-center justify-between gap-4">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton
                      className={cn(
                        "h-3.5",
                        SKELETON_WIDTHS[(cardIndex + line) % SKELETON_WIDTHS.length],
                      )}
                    />
                  </span>
                ))}
              </div>
            ))}
          </div>
        ) : error || empty ? (
          <div className="px-4">{stateBlock}</div>
        ) : (
          <div className={cn("grid divide-y", arrivedContent && "sk-fade-in")}>
            {rows.map((row, index) => {
              const leaving = leavingAt(index);
              const open = onOpen && !leaving ? () => onOpen(row.original) : null;
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
                          label: rowLabel?.(row.original),
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
                <div
                  key={row.id}
                  className={cn(
                    "flex min-w-0 flex-col gap-3 p-4 text-left",
                    open && "cursor-pointer",
                    rowMotionClass(row.original, index),
                  )}
                  onClick={
                    open
                      ? (event) => {
                          if (fromInteractive(event)) return;
                          open();
                        }
                      : undefined
                  }
                  aria-hidden={leaving ? true : undefined}
                  data-testid={leaving ? undefined : `${collectionId}-mobile-row-${index}`}
                  data-family-slot={leaving ? undefined : "list-row"}
                  data-family-collection-row={leaving ? undefined : "true"}
                  data-family-collection-mobile-card="true"
                  data-action-scope="row"
                >
                  {card}
                  {actions ? <span className="flex justify-end gap-1">{actions}</span> : null}
                </div>
              );
            })}
          </div>
        )}
        {infinite && !showSkeleton && !error ? (
          <InfiniteSentinel infinite={infinite} testId={`${collectionId}-mobile-more`} />
        ) : null}
      </div>
    </div>
  );
}
