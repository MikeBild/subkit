// The closed pattern set (spec §6). Pages compose these; only this directory
// imports `@/components/ui/*`.

export { ActionMenu, type ActionMenuItem } from "./action-menu";
export { ChatCard } from "./chat-card";
export { CodeBlock } from "./code-block";
export { ConfirmDialog, confirmTitle } from "./confirm-dialog";
export { ContextHelp } from "./context-help";
export { CopyField, useCopy } from "./copy-field";
export { DataState, type DataStateKind, LOADING_ROWS } from "./data-state";
export {
  type CockpitColumn,
  type CockpitColumnMeta,
  type CockpitTableFeatures,
  cockpitTableFeatures,
  DataTable,
  RowName,
  rowLinkColumn,
  type TableEmptyState,
  type TableErrorState,
} from "./data-table";
export { type Fact, FactList } from "./fact-list";
export { FilterBar, type FilterSelect, MAX_FILTER_SELECTS } from "./filter-bar";
export { type DialogSize, dialogWidthClass, FormDialog } from "./form-dialog";
export { Page, type PageKind, type PageSurface, pageColumn } from "./page";
export { BackLink, PageHeader } from "./page-header";
export { type PageTab, PageTabs, searchWithTab, tabFromSearch } from "./page-tabs";
export { RecordSheet, type SheetSize, sheetWidthClass } from "./record-sheet";
export { activeRouteTab, type RouteTab, RouteTabs } from "./route-tabs";
export { CollapsibleSection, SECTION_LABEL, Section } from "./section";
export { SegmentedControl, type SegmentedOption } from "./segmented-control";
export { type BadgeTone, StatusBadge, statusTone } from "./status-badge";
export { StatusStrip, type StatusTone } from "./status-strip";
export { SummaryLine } from "./summary-line";
