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
  Search,
} from "lucide-react";
import {
  createContext,
  Fragment,
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
import { PREFETCH_MARGIN, scrollRoot, wantsNextPage } from "@/lib/infinite-scroll";
import { useArrived, useLoadingPhase } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";
import { useColumnToggleClaim } from "./column-toggle-claim";
import { DataState, LOADING_ROWS } from "./data-state";
import { useRowMotion } from "./row-motion";
import { Skeleton } from "./skeleton";

export interface CockpitColumnMeta {
  width?: string;
  align?: "start" | "end";
  ownsRowLink?: boolean;
  interactive?: boolean;
  priority?: "high" | "low";
  cardLabel?: boolean;
}

export const MOBILE_CARD_FACTS = 2;

export function priorityClass(priority: CockpitColumnMeta["priority"]): string | undefined {
  return priority === "low" ? "hidden @4xl:table-cell" : undefined;
}

export interface InfiniteRows {
  fetchNextPage(): unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

export function InfiniteSentinel({
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
    if (!element || !hasNextPage || isFetchingNextPage) return;
    if (typeof IntersectionObserver === "undefined") return;
    const root = scrollRoot(element, (box) => getComputedStyle(box).overflowY);
    const observer = new IntersectionObserver(
      (entries) => {
        if (wantsNextPage(entries, { hasNextPage, isFetchingNextPage })) void fetchNextPage();
      },
      { root, rootMargin: PREFETCH_MARGIN },
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

export function rowLinkColumn(
  visible: readonly { id: string; interactive?: boolean; ownsRowLink?: boolean }[],
  preferred?: string,
): string | undefined {
  const chosen = visible.find((column) => column.id === (preferred ?? visible[0]?.id));
  if (chosen && (!chosen.interactive || chosen.ownsRowLink)) return chosen.id;
  return visible.find((column) => !column.interactive)?.id;
}

export function tableColumnWidths(
  widths: readonly (string | undefined)[],
  controls: { actions: boolean; chevron: boolean },
): string[] {
  const specified = widths.map((width) => {
    const match = width?.match(/w-\[(\d+(?:\.\d+)?)%\]/);
    return match ? Number(match[1]) : undefined;
  });
  const known = specified.filter((weight): weight is number => weight !== undefined);
  const fallback = known.length ? known.reduce((sum, weight) => sum + weight, 0) / known.length : 1;
  const weights = specified.map((weight) => weight ?? fallback);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const reservedRem = (controls.actions ? 14 : 0) + (controls.chevron ? 2 : 0);
  return weights.map((weight) => {
    const share = weight / total;
    return `calc(${(share * 100).toFixed(4)}cqw - ${(share * reservedRem).toFixed(4)}rem)`;
  });
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
  zero: { title: string; description?: string; action?: ReactNode };
  filtered: {
    title: string;
    description: string;
    resetLabel: string;
    onReset(): void;
  };
}

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

const INTERACTIVE =
  'a, button, input, select, textarea, label, summary, [role="menuitem"], [role="checkbox"], [role="combobox"]';

function isElement(target: EventTarget | null): target is Element {
  return target !== null && typeof (target as Partial<Element>).closest === "function";
}

export function opensRow(event: { target: EventTarget | null; currentTarget: Element }): boolean {
  const { target, currentTarget } = event;
  if (!isElement(target) || !currentTarget.contains(target)) return false;
  const control = target.closest(INTERACTIVE);
  return control === null || !currentTarget.contains(control);
}

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

interface RowLinkTarget {
  href: string | null;
  onOpen: () => void;
  testId: string;
  label?: string;
}

const RowLinkContext = createContext<RowLinkTarget | null>(null);

export function RowName({ children }: { children: ReactNode }) {
  const target = useContext(RowLinkContext);
  return target ? <RowLink {...target}>{children}</RowLink> : children;
}

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
    "block w-full min-w-0 rounded-sm text-left font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
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
  canOpen,
  rowHref,
  rowLabel,
  linkColumn,
  toolbar,
  pending,
  error,
  emptyState,
  hasActiveFilters,
  infinite,
  getRowId,
  skeletonRows = LOADING_ROWS,
  total,
  columnsLabel,
  recordsLabel,
  actionsLabel,
  rowActions,
  collectionId = "data-table",
  collectionTier = "primary",
  layout = "responsive",
  pickColumns = true,
  searchLabel = "Tabelle durchsuchen",
  searchText = (row) => JSON.stringify(row) ?? "",
  showDefaultSearch,
  grouping,
  groupingTabs,
}: {
  columns: CockpitColumn<TData>[];
  data: TData[];
  sorting: SortingState;
  onSortingChange(value: SortingState): void;
  onOpen?(row: TData): void;
  canOpen?(row: TData): boolean;
  rowHref?(row: TData): string | null;
  rowLabel?(row: TData): string;
  linkColumn?: string;
  toolbar?: ReactNode;
  rowActions?: (row: TData, index: number) => ReactNode;
  pending?: boolean;
  error?: TableErrorState | null;
  emptyState: TableEmptyState;
  hasActiveFilters: boolean;
  infinite?: InfiniteRows;
  getRowId?(row: TData): string;
  skeletonRows?: number;
  total?: number;
  columnsLabel: string;
  recordsLabel?: string;
  actionsLabel: string;
  collectionId?: string;
  collectionTier?: "primary" | "embedded";
  layout?: "responsive" | "rows";
  pickColumns?: boolean;
  searchLabel?: string;
  searchText?: (row: TData) => string;
  showDefaultSearch?: boolean;
  grouping?: {
    getKey(row: TData): string;
    label?(key: string): string;
    compareKeys?(left: string, right: string): number;
  };
  groupingTabs?: ReactNode;
}) {
  const searchInputId = useId();
  const [queryText, setQueryText] = useState("");
  const filteredData = useMemo(() => {
    const needle = queryText.trim().toLocaleLowerCase();
    if (!needle || collectionTier === "embedded") return data;
    return data.filter((row) => searchText(row).toLocaleLowerCase().includes(needle));
  }, [collectionTier, data, queryText, searchText]);
  const orderedData = useMemo(() => {
    if (!grouping) return filteredData;
    return [...filteredData].sort((left, right) => {
      const leftKey = grouping.getKey(left);
      const rightKey = grouping.getKey(right);
      return grouping.compareKeys?.(leftKey, rightKey) ?? leftKey.localeCompare(rightKey);
    });
  }, [filteredData, grouping]);
  const { t } = useI18n();
  const phase = useLoadingPhase(Boolean(pending));
  const arrivedContent = useArrived(phase);
  const motion = useRowMotion(orderedData, getRowId, !pending && !error);
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
  const hideableColumns = table
    .getAllLeafColumns()
    .filter((column) => column.getCanHide() && typeof column.columnDef.header === "string");
  const showColumnPicker = useColumnToggleClaim(
    pickColumns && collectionTier === "primary" && hideableColumns.length > 1,
  );
  const hasActionColumn = Boolean(rowActions);
  const hasChevron = Boolean(onOpen);
  const contentColumnWidths = tableColumnWidths(
    visibleColumns.map((column) => column.columnDef.meta?.width),
    { actions: hasActionColumn, chevron: hasChevron },
  );
  const widthByColumnId = new Map(
    visibleColumns.map((column, index) => [column.id, contentColumnWidths[index]]),
  );
  const bodySpan = visibleColumns.length + (hasActionColumn ? 1 : 0) + (hasChevron ? 1 : 0);
  const linkColumnId = rowLinkColumn(
    visibleColumns.map((column) => ({
      id: column.id,
      interactive: column.columnDef.meta?.interactive,
      ownsRowLink: column.columnDef.meta?.ownsRowLink,
    })),
    linkColumn ?? visibleColumns[0]?.id,
  );
  const rows = table.getRowModel().rows;
  const groupHeader = (row: TData, index: number) =>
    grouping && (index === 0 || grouping.getKey(rows[index - 1]!.original) !== grouping.getKey(row))
      ? (grouping.label?.(grouping.getKey(row)) ?? grouping.getKey(row))
      : null;
  const resultCount = queryText.trim() ? filteredData.length : (total ?? data.length);
  const showSkeleton = phase !== "content";
  const empty = !showSkeleton && !error && rows.length === 0;
  const emptyCopy = hasActiveFilters ? emptyState.filtered : emptyState.zero;
  const usesDefaultSearch = collectionTier === "primary" && (showDefaultSearch ?? !toolbar);
  const toolbarShown = usesDefaultSearch || Boolean(toolbar) || showColumnPicker;
  const cards = layout === "responsive";
  const resultCountLabel = (
    <span
      className="sr-only"
      aria-live="polite"
      data-family-slot="collection-meta"
      data-family-result-count
      data-testid={`${collectionId}-count`}
    >
      {showSkeleton ? "" : `${recordsLabel ?? t("platform.results")}: ${resultCount}`}
    </span>
  );

  const stateBlock = pending ? null : error ? (
    <DataState
      state="error"
      line={error.title}
      testId={`${collectionId}-error`}
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

  const stateOnly = !showSkeleton && Boolean(error || empty);
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
          : cards
            ? "sort responsive-cards loading-state empty-state error-state"
            : "sort loading-state empty-state error-state"
      }
      data-family-state={pending ? "loading" : error ? "error" : empty ? "empty" : "ready"}
      data-review-layout={groupingTabs ? "true" : undefined}
      aria-busy={pending ? true : undefined}
    >
      {toolbarShown ? (
        <div className="flex flex-wrap items-center gap-2 pb-2" data-family-slot="list-toolbar">
          {usesDefaultSearch && (
            <label htmlFor={searchInputId} className="relative min-w-52 flex-1 sm:max-w-xs">
              <span className="sr-only">{searchLabel}</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id={searchInputId}
                type="search"
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                placeholder={searchLabel}
                className="pl-8"
                data-family-action="search"
                data-testid={`${collectionId}-search`}
              />
            </label>
          )}
          {toolbar}
          {resultCountLabel}
          {showColumnPicker ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="ms-auto hidden @2xl:inline-flex"
                  data-testid={`${collectionId}-columns`}
                >
                  <Columns3 data-icon="inline-start" />
                  {columnsLabel}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{columnsLabel}</DropdownMenuLabel>
                <DropdownMenuGroup>
                  {hideableColumns.map((column) => (
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
          ) : null}
        </div>
      ) : (
        resultCountLabel
      )}
      {groupingTabs}
      <div
        className={cn(
          "@container min-h-0 overflow-auto",
          cards ? "hidden @4xl:block" : "block",
          stateOnly ? null : "rounded-lg border",
        )}
        data-testid={`${collectionId}-desktop`}
      >
        {stateOnly ? stateBlock : null}
        <Table className={stateOnly ? "hidden" : undefined}>
          <TableHeader className="sticky top-0 z-10 bg-background">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      style={{ width: widthByColumnId.get(header.column.id) }}
                      className={cn(
                        header.column.columnDef.meta?.width,
                        header.column.columnDef.meta?.align === "end" && "text-right",
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
                  <TableHead className="w-56" style={{ width: "14rem" }}>
                    <span className="sr-only">{actionsLabel}</span>
                  </TableHead>
                ) : null}
                {hasChevron ? (
                  <TableHead className="w-8" style={{ width: "2rem" }} aria-hidden="true" />
                ) : null}
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
                      style={{ width: widthByColumnId.get(column.id) }}
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
                  {hasActionColumn ? (
                    <TableCell className="w-56" style={{ width: "14rem" }} />
                  ) : null}
                  {hasChevron ? <TableCell className="w-8" style={{ width: "2rem" }} /> : null}
                </TableRow>
              ))
            ) : error || empty ? (
              <TableRow>
                <TableCell colSpan={bodySpan}>{stateBlock}</TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => {
                const leaving = leavingAt(index);
                const heading = leaving ? null : groupHeader(row.original, index);
                const open =
                  onOpen && !leaving && (canOpen?.(row.original) ?? true)
                    ? () => onOpen(row.original)
                    : null;
                return (
                  <Fragment key={row.id}>
                    {heading ? (
                      <TableRow data-slot="group-heading" className="bg-muted/40 hover:bg-muted/40">
                        <TableCell
                          colSpan={bodySpan}
                          className="py-2 text-xs font-semibold text-muted-foreground"
                        >
                          {heading}
                        </TableCell>
                      </TableRow>
                    ) : null}
                    <TableRow
                      data-family-slot={leaving ? undefined : "list-row"}
                      data-family-collection-row={leaving ? undefined : "true"}
                      aria-hidden={leaving ? true : undefined}
                      className={cn(
                        "h-11",
                        open && "cursor-pointer",
                        rowMotionClass(row.original, index),
                      )}
                      data-testid={leaving ? undefined : `${collectionId}-row-${index}`}
                      onClick={
                        open
                          ? (event) => {
                              if (opensRow(event)) open();
                            }
                          : undefined
                      }
                    >
                      {row.getVisibleCells().map((cell, cellIndex) => (
                        <TableCell
                          key={cell.id}
                          style={{ width: widthByColumnId.get(cell.column.id) }}
                          className={cn(
                            "min-w-0",
                            cell.column.columnDef.meta?.align === "end" && "text-right",
                            priorityClass(cell.column.columnDef.meta?.priority),
                            cellIndex === 0 ? "font-medium" : "text-muted-foreground",
                          )}
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
                        <TableCell
                          className="w-56 whitespace-nowrap"
                          style={{ width: "14rem" }}
                          data-slot="row-actions"
                        >
                          <span className="flex max-w-full flex-wrap items-center justify-end gap-1">
                            {rowActions?.(row.original, index)}
                          </span>
                        </TableCell>
                      ) : null}
                      {hasChevron ? (
                        <TableCell
                          className="w-8 text-muted-foreground"
                          style={{ width: "2rem" }}
                          data-slot="row-chevron"
                        >
                          {open ? <ChevronRight aria-hidden="true" className="size-4" /> : null}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
        {infinite && !showSkeleton && !error ? (
          <InfiniteSentinel infinite={infinite} testId={`${collectionId}-more`} />
        ) : null}
      </div>
      {cards ? (
        <div className="min-h-0 overflow-y-auto @4xl:hidden" data-testid={`${collectionId}-mobile`}>
          {showSkeleton ? (
            <div
              className={cn("grid divide-y", phase === "reserve" ? "invisible" : "sk-fade-in")}
              data-family-slot="data-state"
              data-family-state="loading"
              aria-busy="true"
            >
              {Array.from({ length: skeletonRows }, (_, cardIndex) => (
                <div key={cardIndex} className="grid gap-y-0.5 px-3 py-2.5">
                  {Array.from({ length: 1 + MOBILE_CARD_FACTS }, (_, line) => (
                    <span key={line} className="flex h-5 items-center">
                      <Skeleton
                        className={cn(
                          line === 0 ? "h-3.5" : "h-3",
                          SKELETON_WIDTHS[(cardIndex + line) % SKELETON_WIDTHS.length],
                        )}
                      />
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ) : error || empty ? (
            stateBlock
          ) : (
            <div className={cn("grid divide-y rounded-lg border", arrivedContent && "sk-fade-in")}>
              {rows.map((row, index) => {
                const leaving = leavingAt(index);
                const heading = leaving ? null : groupHeader(row.original, index);
                const open =
                  onOpen && !leaving && (canOpen?.(row.original) ?? true)
                    ? () => onOpen(row.original)
                    : null;
                const all = row.getVisibleCells();
                const named = open
                  ? all.find((cell) => cell.column.id === linkColumnId)
                  : undefined;
                const title = named ?? all[0];
                const facts = all
                  .filter(
                    (cell) => cell !== title && cell.column.columnDef.meta?.priority !== "low",
                  )
                  .slice(0, MOBILE_CARD_FACTS);
                const actions = rowActions?.(row.original, index);
                return (
                  <Fragment key={row.id}>
                    {heading ? (
                      <div
                        data-slot="group-heading"
                        className="bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground"
                      >
                        {heading}
                      </div>
                    ) : null}
                    <div
                      className={cn(
                        "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 px-3 py-2.5 text-left text-sm",
                        open && "cursor-pointer transition-colors hover:bg-muted/50",
                        rowMotionClass(row.original, index),
                      )}
                      onClick={
                        open
                          ? (event) => {
                              if (opensRow(event)) open();
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
                      {title ? (
                        <span
                          className="col-start-1 min-w-0 break-words font-medium"
                          data-family-slot="card-title"
                        >
                          {open && title === named ? (
                            <LinkedCell
                              owns={Boolean(title.column.columnDef.meta?.ownsRowLink)}
                              target={{
                                href: rowHref?.(row.original) ?? null,
                                onOpen: open,
                                testId: `${collectionId}-mobile-row-link-${index}`,
                                label: rowLabel?.(row.original),
                              }}
                            >
                              <table.FlexRender cell={title} />
                            </LinkedCell>
                          ) : (
                            <table.FlexRender cell={title} />
                          )}
                        </span>
                      ) : null}
                      {facts.map((cell) => (
                        <span
                          key={cell.id}
                          className="col-start-1 min-w-0 break-words text-[13px] leading-5 text-muted-foreground"
                          data-family-slot="card-fact"
                        >
                          {cell.column.columnDef.meta?.cardLabel &&
                          typeof cell.column.columnDef.header === "string"
                            ? `${cell.column.columnDef.header} `
                            : null}
                          <table.FlexRender cell={cell} />
                        </span>
                      ))}
                      {actions ? (
                        <span
                          className="col-start-2 row-start-1 flex items-center gap-1 self-center"
                          style={{ gridRowEnd: `span ${1 + facts.length}` }}
                        >
                          {actions}
                        </span>
                      ) : null}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          )}
          {infinite && !showSkeleton && !error ? (
            <InfiniteSentinel infinite={infinite} testId={`${collectionId}-mobile-more`} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
