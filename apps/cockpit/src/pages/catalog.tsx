import type { components } from "@cli-core/engine-api/openapi";
import { useNavigate } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { IconTile } from "@ui/components/proto/visual";
import { listPageFailure } from "@ui/lib/errors";
import { Bot, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { absolute, chatNewHref, recordHref, runsHref } from "@/app/links";
import { CatalogSummary, useCatalogCreatedBy } from "@/components/cockpit/catalog-categories";
import {
  CatalogCategoryChips,
  catalogCategoryGrouping,
  categoryCounts,
} from "@/components/cockpit/catalog-grouping";
import { CatalogNameCell } from "@/components/cockpit/catalog-metadata";
import { recordCategory } from "@/components/cockpit/catalog-metadata-model";
import { CATALOG_CREATED_BY_FILTER } from "@/components/cockpit/catalog-origin-model";
import { CreateAction } from "@/components/cockpit/create-choice";
import { usePackageActions } from "@/components/cockpit/package-dialogs";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  DataTable,
  FilterBar,
  type FilterSelect,
  GroupingChoice,
  Page,
  PageHeader,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { WorkflowOnboarding } from "@/components/cockpit/workflow-onboarding";
import { TRIGGER_ICONS } from "@/components/cockpit/workflow-steps-list";
import { ForbiddenState } from "@/components/failure-state";
import { WorkflowStatusPill } from "@/features/operations";
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS, type Locale, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { type CursorPage, useInfiniteList } from "@/lib/use-infinite-list";
import { humanizeCategory } from "@/lib/workflow-category";
import { triggerKindOf } from "@/lib/workflow-flow";
import {
  CATALOG_CATEGORY_GROUP,
  CATALOG_WORKFLOW_FILTER_STATUSES,
  CATALOG_WORKFLOW_GROUPS,
  catalogGroupFromSearch,
  catalogListParams,
  catalogOperatingStatus,
  OPERATING_STATUS_KEYS,
  type WorkflowStatusFilter,
  workflowNeedsAttention,
} from "@/pages/catalog-model";
import { triggerLabelKey } from "@/pages/workflows-model";

type CatalogRow = Record<string, unknown>;
type WorkflowListItem = components["schemas"]["WorkflowListItem"];

interface CatalogState {
  q: string;
  status: WorkflowStatusFilter;
  category: string;
  connector: string;
  sort: string;
  order: "asc" | "desc";
  group: string;
}

interface CategoryCount {
  category: string;
  count: number;
}

interface CatalogListPage extends CursorPage<CatalogRow> {
  categories?: CategoryCount[];
}

export function catalogCountLine(
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  count: number,
): string {
  return t(count === 1 ? "resource.workflows.summary.one" : "resource.workflows.summary.other", {
    count,
  });
}

const DEFAULT_SORT = "updated_at";

const PAGE_SIZE = 25;

function parseState(): CatalogState {
  const params = new URLSearchParams(window.location.search);
  const order = params.get("order");
  return {
    q: params.get("q") ?? "",
    status: (CATALOG_WORKFLOW_FILTER_STATUSES as readonly string[]).includes(
      params.get("operating_status") ?? "",
    )
      ? (params.get("operating_status") as WorkflowStatusFilter)
      : "all",
    category: params.get("category") ?? "all",
    connector: params.get("connector") ?? "",
    sort: params.get("sort") ?? DEFAULT_SORT,
    order: order === "asc" ? "asc" : "desc",
    group: catalogGroupFromSearch(window.location.search, CATALOG_WORKFLOW_GROUPS),
  };
}

function useCatalogState() {
  const [state, setStateValue] = useState<CatalogState>(() => parseState());
  const stateRef = useRef(state);
  useEffect(() => {
    const onPopState = () => {
      const next = parseState();
      stateRef.current = next;
      setStateValue(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const setState = useCallback((patch: Partial<CatalogState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    const params = new URLSearchParams();
    if (next.q) params.set("q", next.q);
    if (next.status !== "all") params.set("operating_status", next.status);
    if (next.category !== "all") params.set("category", next.category);
    if (next.connector) params.set("connector", next.connector);
    if (next.sort !== DEFAULT_SORT) params.set("sort", next.sort);
    if (next.order !== "desc") params.set("order", next.order);
    if (next.group !== CATALOG_CATEGORY_GROUP) params.set("group", next.group);
    const origin = new URLSearchParams(window.location.search).get("origin");
    if (origin) params.set("origin", origin);
    const suffix = params.size > 0 ? `?${params}` : "";
    const href = `${window.location.pathname}${suffix}`;
    if (href !== `${window.location.pathname}${window.location.search}`)
      window.history.pushState({}, "", href);
    setStateValue(next);
  }, []);
  return [state, setState] as const;
}

function stringField(row: CatalogRow, field: string): string | null {
  const value = row[field];
  return typeof value === "string" && value ? value : null;
}

function HealthMark({ row, index }: { row: CatalogRow; index: number }) {
  const { t } = useI18n();
  const state = stringField(row, "health_state");
  const id = stringField(row, "id");
  if (!state || state === "ok") return null;
  const badge = <StatusBadge state={state} />;
  return id ? (
    <a
      href={absolute(runsHref({ workflowId: id, status: "failed" }))}
      className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("workflows.health", { state: statusLabel(t, state) })}
      data-testid={`workflow-health-link-${index}`}
      onClick={(event) => event.stopPropagation()}
    >
      {badge}
    </a>
  ) : (
    badge
  );
}

function catalogColumns(
  t: ReturnType<typeof useI18n>["t"],
  dateTime: ReturnType<typeof useI18n>["dateTime"],
  relations: { locale: Locale; hideCategory: boolean },
): CockpitColumn<CatalogRow>[] {
  const column = tableColumns<CatalogRow>({ t, dateTime });
  return [
    column.custom(
      "name",
      (row) => row.name,
      t("common.name"),
      (row) => (
        <CatalogNameCell
          name={stringField(row, "name") ?? ""}
          record={row}
          hideCategory={relations.hideCategory}
          icon={<IconTile icon={Workflow} size="md" />}
        />
      ),
      { sortable: true, width: "w-[38%]" },
    ),
    column.custom(
      "operating_status",
      (row) => row.operating_status,
      t("catalog.status"),
      (row, index) => {
        const status = catalogOperatingStatus(row.operating_status);
        return (
          <span className="flex min-w-0 flex-col items-start gap-1">
            <WorkflowStatusPill
              status={status}
              label={t(OPERATING_STATUS_KEYS[status])}
              testId={`workflow-status-${index}`}
            />
            <HealthMark row={row} index={index} />
          </span>
        );
      },
      { width: "w-[22%]", interactive: true },
    ),
    column.custom(
      "trigger",
      (row) => row.effective_trigger,
      t("catalog.trigger"),
      (row) => {
        const trigger = row.effective_trigger as WorkflowListItem["effective_trigger"];
        const schedule = row.schedule as WorkflowListItem["schedule"];
        const label = t(triggerLabelKey(trigger));
        const Icon = TRIGGER_ICONS[triggerKindOf(trigger)];
        return (
          <span className="inline-flex items-center gap-1.5">
            <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {trigger.kind === "schedule" && schedule?.cron
              ? `${label} · ${cronWords(schedule.cron, t, LOCALE_TAGS[relations.locale])}`
              : label}
          </span>
        );
      },
      { width: "w-[22%]" },
    ),
    column.date("last_executed_at", (row) => row.last_executed_at, t("catalog.lastRun"), {
      width: "w-[18%]",
    }),
  ];
}

export function CatalogPage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime, locale } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useCatalogState();
  const [search, setSearch] = useState(state.q);
  const groupMode = state.group;
  const setGroupMode = useCallback((group: string) => setState({ group }), [setState]);
  const origin = useCatalogCreatedBy();
  const debouncedSearch = useDebouncedValue(search);
  useEffect(() => setSearch(state.q), [state.q]);
  useEffect(() => {
    if (debouncedSearch !== state.q) setState({ q: debouncedSearch });
  }, [debouncedSearch, setState, state.q]);

  const params = useMemo(
    () => ({ ...catalogListParams(state), description_source: origin.descriptionSource }),
    [state, origin.descriptionSource],
  );
  const list = useInfiniteList<CatalogRow, CatalogListPage>("/v1/workflows", params, {
    limit: PAGE_SIZE,
    enabled: permissions.includes("workflow:read"),
    queryKey: ["catalog", "workflows", params],
  });
  const query = list.query;

  const columns = useMemo(
    () =>
      catalogColumns(t, dateTime, {
        locale,
        hideCategory: groupMode === CATALOG_CATEGORY_GROUP,
      }),
    [t, dateTime, locale, groupMode],
  );
  const sorting: SortingState = [{ id: state.sort, desc: state.order === "desc" }];
  const rows = list.items;
  const total = list.total ?? rows.length;
  const categories = useMemo(() => list.first?.categories ?? [], [list.first]);
  const title = t("resource.workflows.title");
  const narrowed =
    Boolean(state.q) || state.status !== "all" || Boolean(state.connector) || origin.active;
  const grouping =
    groupMode === "all"
      ? undefined
      : groupMode === CATALOG_CATEGORY_GROUP
        ? catalogCategoryGrouping<CatalogRow>({
            getCategory: (row) => recordCategory(row),
            otherLabel: t("catalog.categoryOther"),
            ...(narrowed ? {} : { counts: categoryCounts(categories) }),
            needsAttention: workflowNeedsAttention,
          })
        : {
            getKey: (row: CatalogRow) =>
              groupMode === "trigger"
                ? t(triggerLabelKey(row.effective_trigger as WorkflowListItem["effective_trigger"]))
                : t(OPERATING_STATUS_KEYS[catalogOperatingStatus(row.operating_status)]),
          };
  const hasActiveFilters =
    Boolean(state.q) ||
    state.status !== "all" ||
    state.category !== "all" ||
    Boolean(state.connector) ||
    origin.active;

  const showsZeroStateAction =
    rows.length === 0 &&
    !hasActiveFilters &&
    !query.isPending &&
    !query.error &&
    !query.failureReason;
  const onboarding = showsZeroStateAction;

  const resetFilters = useCallback(() => {
    setSearch("");
    origin.setValue("all");
    setState({
      q: "",
      status: "all",
      category: "all",
      connector: "",
    });
  }, [setState, origin.setValue]);
  const packages = usePackageActions({
    permissions,
    kind: "workflow",
    category: state.category === "all" ? undefined : state.category,
  });

  if (!permissions.includes("workflow:read")) {
    return (
      <Page
        kind="list"
        surface="collection"
        testId="catalog-workflows"
        scroll="page"
        header={<PageHeader title={title} />}
      >
        <ForbiddenState />
      </Page>
    );
  }

  const selects: FilterSelect[] = [];
  if (categories.length > 0)
    selects.push({
      value: state.category,
      onChange: (category) => setState({ category }),
      label: t("catalog.block"),
      testId: "catalog-category-filter",
      options: [
        { value: "all", label: t("catalog.allCategories") },
        ...categories.map((entry) => ({
          value: entry.category,
          label: `${categoryLabel(entry.category, t)} (${entry.count})`,
        })),
      ],
    });
  selects.push({
    value: state.status,
    onChange: (status) => setState({ status: status as WorkflowStatusFilter }),
    label: t("catalog.filterStatus"),
    testId: "catalog-status-filter",
    options: [
      { value: "all", label: t("catalog.allStatuses") },
      ...CATALOG_WORKFLOW_FILTER_STATUSES.map((status) => ({
        value: status,
        label: t(OPERATING_STATUS_KEYS[catalogOperatingStatus(status)]),
      })),
    ],
  });
  selects.push(origin.select);

  const primaryAction = (testId: string) =>
    permissions.includes("workflow:write") ? (
      <CreateAction
        kind="workflow"
        canChat={permissions.includes("conversation:write")}
        size={testId === "catalog-empty-action" ? "sm" : "default"}
        testId={testId}
      />
    ) : (
      <Button asChild size={testId === "catalog-empty-action" ? "sm" : "default"}>
        <a
          href={absolute(chatNewHref({ prompt: t("resource.workflows.action") }))}
          data-testid={testId}
        >
          <Bot data-icon="inline-start" />
          {t("resource.workflows.action")}
        </a>
      </Button>
    );

  return (
    <Page
      kind="list"
      surface="collection"
      testId="catalog-workflows"
      scroll="content"
      failure={listPageFailure({
        failed: Boolean(query.error || query.failureReason),
        loaded: query.data !== undefined,
        onRetry: () => void query.refetch(),
        error: query.error ?? query.failureReason,
        collectionId: "data-table",
      })}
      header={
        <PageHeader
          title={title}
          purpose={t("catalog.lead")}
          action={
            showsZeroStateAction && !onboarding
              ? undefined
              : primaryAction("catalog-primary-action")
          }
          menu={
            packages.items.length > 0 ? (
              <ActionMenu
                alwaysMenu
                testId="catalog-workflows-page-actions"
                items={packages.items}
              />
            ) : undefined
          }
        />
      }
    >
      {onboarding ? (
        <WorkflowOnboarding
          canWrite={permissions.includes("workflow:write")}
          canChat={permissions.includes("conversation:write")}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {query.isPending || rows.length > 0 || hasActiveFilters ? (
            <CatalogSummary
              loading={query.isPending}
              text={catalogCountLine(t, total)}
              kind="workflow"
              testId="catalog-summary"
            />
          ) : null}
          <DataTable
            columns={columns}
            data={rows}
            groupingTabs={
              <>
                <GroupingChoice
                  label={t("common.groupBy")}
                  value={groupMode}
                  onChange={setGroupMode}
                  options={[
                    { value: "all", label: t("common.all") },
                    { value: CATALOG_CATEGORY_GROUP, label: t("resource.field.category") },
                    { value: "status", label: t("catalog.status") },
                    { value: "trigger", label: t("catalog.trigger") },
                  ]}
                  testId="catalog-workflows-grouping"
                  note={
                    groupMode === "all" || groupMode === CATALOG_CATEGORY_GROUP
                      ? undefined
                      : t("common.loadedOnly")
                  }
                />
                <CatalogCategoryChips
                  usage={categories}
                  value={state.category}
                  onChange={(category) => setState({ category })}
                  loading={query.isPending}
                />
              </>
            }
            grouping={grouping}
            toolbar={
              <>
                <FilterBar
                  search={{
                    value: search,
                    onChange: setSearch,
                    placeholder: t("resource.search", { resource: title }),
                    testId: "catalog-search",
                  }}
                  selects={selects}
                  onApply={(changes) => {
                    const patch: Partial<CatalogState> = {};
                    if (changes["catalog-category-filter"])
                      patch.category = changes["catalog-category-filter"];
                    if (changes["catalog-status-filter"])
                      patch.status = changes["catalog-status-filter"] as WorkflowStatusFilter;
                    const createdBy = changes[CATALOG_CREATED_BY_FILTER];
                    if (createdBy !== undefined) origin.select.onChange(createdBy);
                    if (Object.keys(patch).length > 0) setState(patch);
                  }}
                  reset={{ label: t("catalog.clearFilters"), onClick: resetFilters }}
                />
                {origin.chip}
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="catalog-clear-filters"
                    onClick={resetFilters}
                  >
                    {t("catalog.clearFilters")}
                  </Button>
                )}
              </>
            }
            pending={query.isPending && !query.failureReason}
            error={
              query.error || query.failureReason
                ? {
                    title: t("resource.loadFailed", { resource: title }),
                    description: t("resource.loadFailedDescription"),
                    retryLabel: t("session.retry"),
                    onRetry: () => void query.refetch(),
                  }
                : null
            }
            emptyState={{
              zero: {
                title: t("resource.workflows.empty"),
                action: primaryAction("catalog-empty-action"),
              },
              filtered: {
                title: t("resource.noMatches"),
                description: t("resource.broaderSearch"),
                resetLabel: t("catalog.clearFilters"),
                onReset: resetFilters,
              },
            }}
            hasActiveFilters={hasActiveFilters}
            sorting={sorting}
            onSortingChange={(next) => {
              const first = next[0];
              if (first)
                setState({
                  sort: first.id,
                  order: first.desc ? "desc" : "asc",
                });
            }}
            getRowId={(row) => (typeof row.id === "string" ? row.id : "")}
            onOpen={(row) => {
              if (typeof row.id === "string")
                void navigate({ to: recordHref("workflows", row.id) });
            }}
            rowHref={(row) => (typeof row.id === "string" ? recordHref("workflows", row.id) : null)}
            total={total}
            infinite={list.infinite}
            columnsLabel={t("catalog.columns")}
            pickColumns={false}
            recordsLabel={t("catalog.records")}
            actionsLabel={t("common.actions")}
          />
        </div>
      )}
      {packages.dialogs}
    </Page>
  );
}

function categoryLabel(category: string, t: ReturnType<typeof useI18n>["t"]): string {
  return humanizeCategory(category, t("catalog.categoryOther"));
}
