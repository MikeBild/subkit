import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { Bot, FolderTree } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, recordHref, runsHref, workflowsHref } from "@/app/links";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  Button,
  type CockpitColumn,
  DataState,
  DataTable,
  FilterBar,
  type FilterSelect,
  FormDialog,
  Page,
  PageHeader,
  RowName,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/cockpit/patterns";
import { MISSING, type Relation, tableColumns } from "@/components/cockpit/table-columns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  humanizeCategory,
  MIN_CATEGORY_SIZE,
  memberCountAfterMove,
  recategorizedSlug,
  UNCATEGORIZED,
} from "@/lib/workflow-category";
import { catalogListParams } from "@/pages/catalog-model";
import { useConnectionCallback } from "@/pages/connection-callback";
import { driverLabel, environmentLabel } from "@/pages/connector-detail-model";
import {
  type ConnectorHealthFilter,
  connectorHealthFilterFromUrl,
  workflowsByConnector,
} from "@/pages/connectors-model";
import { connectorSlugHref, triggerLabelKey } from "@/pages/workflows-model";

/** The lists this page draws; Wissen's lists have pages of their own. */
type CatalogResource = "workflows" | "connectors";
type CatalogRow = Record<string, unknown>;
type ConnectorListItem = components["schemas"]["ConnectorListItem"];
type WorkflowListItem = components["schemas"]["WorkflowListItem"];

interface CatalogState {
  q: string;
  status: string;
  category: string;
  /** Workflows only: the connector slug whose users are being listed. */
  connector: string;
  /**
   * Connectors only: the narrowing the health tile's link brings. Never typed,
   * so it has no control of its own — only the chip that says so and lifts it.
   */
  health: ConnectorHealthFilter | null;
  sort: string;
  order: "asc" | "desc";
  page: number;
}

interface CategoryCount {
  category: string;
  count: number;
}

interface CatalogConfig {
  endpoint: string;
  permission: string;
  titleKey: TranslationKey;
  emptyKey: TranslationKey;
  actionKey?: TranslationKey;
  defaultSort: string;
  statuses: string[];
}

const CONFIG: Record<CatalogResource, CatalogConfig> = {
  workflows: {
    endpoint: "/v1/workflows",
    permission: "workflow:read",
    titleKey: "resource.workflows.title",
    emptyKey: "resource.workflows.empty",
    actionKey: "resource.workflows.action",
    defaultSort: "updated_at",
    statuses: ["draft", "active", "archived"],
  },
  connectors: {
    endpoint: "/v1/connectors",
    permission: "connector:read",
    titleKey: "resource.connectors.title",
    emptyKey: "resource.connectors.empty",
    actionKey: "resource.connectors.action",
    defaultSort: "updated_at",
    statuses: ["enabled", "disabled", "ok", "degraded", "needs_reauth"],
  },
};

const PAGE_SIZE = 25;
/** One read, inverted client-side, instead of one relation lookup per row. */
const RELATION_INDEX_LIMIT = 200;

function parseState(config: CatalogConfig): CatalogState {
  const params = new URLSearchParams(window.location.search);
  const order = params.get("order");
  return {
    q: params.get("q") ?? "",
    status: params.get("status") ?? "all",
    category: params.get("category") ?? "all",
    connector: params.get("connector") ?? "",
    health:
      config.endpoint === "/v1/connectors"
        ? connectorHealthFilterFromUrl(window.location.search)
        : null,
    sort: params.get("sort") ?? config.defaultSort,
    order: order === "asc" ? "asc" : "desc",
    page: Math.max(0, Number(params.get("page") ?? 0) || 0),
  };
}

function useCatalogState(config: CatalogConfig) {
  const [state, setStateValue] = useState<CatalogState>(() => parseState(config));
  useEffect(() => {
    const onPopState = () => setStateValue(parseState(config));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [config]);
  const setState = useCallback(
    (patch: Partial<CatalogState>) => {
      setStateValue((current) => {
        const next = { ...current, ...patch };
        const params = new URLSearchParams();
        if (next.q) params.set("q", next.q);
        if (next.status !== "all") params.set("status", next.status);
        if (next.category !== "all") params.set("category", next.category);
        if (next.connector) params.set("connector", next.connector);
        if (next.health) params.set("health", next.health);
        if (next.sort !== config.defaultSort) params.set("sort", next.sort);
        if (next.order !== "desc") params.set("order", next.order);
        if (next.page > 0) params.set("page", String(next.page));
        const suffix = params.size > 0 ? `?${params}` : "";
        window.history.pushState({}, "", `${window.location.pathname}${suffix}`);
        return next;
      });
    },
    [config.defaultSort],
  );
  return [state, setState] as const;
}

function stringField(row: CatalogRow, field: string): string | null {
  const value = row[field];
  return typeof value === "string" && value ? value : null;
}

function stringList(row: CatalogRow, field: string): string[] {
  const value = row[field];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Workflow health rides on the name rather than taking an eighth column.
 *
 * A healthy workflow says nothing — the row is already the good news. An
 * unhealthy one carries a dot AND the state as a word, because a colour on its
 * own tells a person who cannot see it nothing (CUI-A11Y-5), and a `title=` or
 * a hover-only tooltip is unreachable by keyboard and invisible on touch
 * (CUI-WORDS-2).
 *
 * The engine's own reason is not repeated here. It is the entry's reason on
 * Übersicht and stands, marked as the engine's, in Übersicht's review sheet and in the
 * cause block of the workflow's own page — one fact, one home. A third copy on
 * every list row was the same sentence in a place nobody acts on it.
 */
function HealthMark({ row, index }: { row: CatalogRow; index: number }) {
  const { t } = useI18n();
  const state = stringField(row, "health_state");
  const id = stringField(row, "id");
  if (!state || state === "ok") return null;
  const tone = state === "degraded" ? "bg-destructive" : "bg-warning";
  // The red mark leads to its cause: the failed runs of this workflow (§1,
  // "kein Rot ohne Weg zur Ursache"). A mark that only says "failed" sends
  // the reader to search the run log by name.
  const sentence = t("workflows.health", { state: statusLabel(t, state) });
  return (
    <span className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className={`mt-1 size-2 shrink-0 rounded-full ${tone}`} />
      <span className="flex min-w-0 flex-col">
        {id ? (
          <a
            href={absolute(runsHref({ workflowId: id, status: "failed" }))}
            className="min-w-0 underline underline-offset-4"
            data-testid={`workflow-health-link-${index}`}
            onClick={(event) => event.stopPropagation()}
          >
            {sentence}
          </a>
        ) : (
          <span className="min-w-0">{sentence}</span>
        )}
      </span>
    </span>
  );
}

function catalogColumns(
  resource: CatalogResource,
  t: ReturnType<typeof useI18n>["t"],
  dateTime: ReturnType<typeof useI18n>["dateTime"],
  relations: {
    connectorIdBySlug: ReadonlyMap<string, string>;
    workflowsByConnectorSlug: ReadonlyMap<string, { id: string; name: string }[]>;
    canReadWorkflows: boolean;
    onCategory(category: string): void;
  },
): CockpitColumn<CatalogRow>[] {
  const column = tableColumns<CatalogRow>({ t, dateTime });

  if (resource === "workflows") {
    return [
      column.custom(
        "name",
        (row) => row.name,
        t("common.name"),
        (row, index) => (
          <span className="flex min-w-0 flex-col gap-1">
            {/* The name is the row's link; the health line below links to the
                failed runs, and a link inside a link is none. */}
            <span className="min-w-0 font-medium">
              <RowName>{stringField(row, "name") ?? MISSING}</RowName>
            </span>
            <HealthMark row={row} index={index} />
          </span>
        ),
        { sortable: true, width: "w-[21%]", ownsRowLink: true, interactive: true },
      ),
      column.status("lifecycle", (row) => row.lifecycle, t("catalog.lifecycle"), {
        sortable: true,
        width: "w-[11%]",
      }),
      column.custom(
        "category",
        (row) => row.category,
        t("catalog.block"),
        (row, index) => {
          const category = stringField(row, "category");
          if (!category) return MISSING;
          return (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 h-auto py-1 font-normal"
              data-testid={`catalog-block-${index}`}
              onClick={(event) => {
                event.stopPropagation();
                relations.onCategory(category);
              }}
            >
              {categoryLabel(category, t)}
            </Button>
          );
        },
        { width: "w-[12%]" },
      ),
      column.chips(
        "connectors",
        (row) =>
          stringList(row, "connectors").map((slug) => ({
            href: connectorSlugHref(slug, relations.connectorIdBySlug),
            label: slug,
          })),
        t("resource.connectors.title"),
        { width: "w-[16%]" },
      ),
      column.custom(
        "trigger",
        (row) => row.effective_trigger,
        t("catalog.trigger"),
        (row) =>
          t(
            triggerLabelKey(
              row.effective_trigger as WorkflowListItem["effective_trigger"] | null | undefined,
            ),
          ),
        { width: "w-[11%]" },
      ),
      // The last run's time leads to the runs of this workflow — the date is
      // the question "what happened then?", and the answer is one click away.
      column.custom(
        "last_executed_at",
        (row) => row.last_executed_at,
        t("catalog.lastRun"),
        (row, index) => {
          const at = stringField(row, "last_executed_at");
          const id = stringField(row, "id");
          if (!at) return MISSING;
          return id ? (
            <a
              href={absolute(runsHref({ workflowId: id }))}
              className="underline-offset-4 hover:underline"
              data-testid={`workflow-last-run-${index}`}
              onClick={(event) => event.stopPropagation()}
            >
              {dateTime(at)}
            </a>
          ) : (
            dateTime(at)
          );
        },
        { width: "w-[14%]" },
      ),
      column.date("updated_at", (row) => row.updated_at, t("catalog.updated"), {
        sortable: true,
        width: "w-[14%]",
      }),
    ];
  }

  const columns: CockpitColumn<CatalogRow>[] = [
    // The name is text. It was a link to the very record the row click and
    // the row's open button already open — three ways to one place, and the
    // one styled as a link looked like it led somewhere else.
    column.text("name", (row) => row.display_name, t("common.name"), {
      sortable: true,
      width: "w-[23%]",
    }),
    // One column for where the connector stands. A second one, "Zugangsdaten",
    // read the same verdict and said it again in other words.
    column.status("health", (row) => row.health_state, t("catalog.health"), {
      width: "w-[18%]",
    }),
    column.custom(
      "enabled",
      (row) => row.enabled,
      t("catalog.enabled"),
      // A yes or no is plain text: a badge is for an engine state (P11).
      (row) => (row.enabled === true ? t("common.yes") : t("common.no")),
      { sortable: true, width: "w-[10%]" },
    ),
    // The same words the connector's own page uses: "Produktion", not "prod";
    // "MCP-Server", not "mcp". Sorting still reads the engine's value.
    column.custom(
      "environment",
      (row) => row.environment,
      t("catalog.environment"),
      (row) => environmentLabel(stringField(row, "environment"), t) || MISSING,
      { sortable: true, width: "w-[13%]" },
    ),
    column.custom(
      "driver",
      (row) => row.driver,
      t("catalog.driver"),
      (row) => driverLabel(stringField(row, "driver"), t) || MISSING,
      { sortable: true, width: "w-[13%]" },
    ),
  ];
  // Without workflow:read the relation cannot be read at all. Dropping the
  // column is honest; rendering "0" would claim a measured count.
  if (relations.canReadWorkflows) {
    columns.push(
      column.link(
        "used_by",
        (row): Relation | null => {
          const slug = stringField(row, "slug");
          if (!slug) return null;
          const users = relations.workflowsByConnectorSlug.get(slug) ?? [];
          if (users.length === 0) return null;
          return {
            href: absolute(workflowsHref({ connector: slug })),
            label: t("connectors.usedByCount", { count: users.length }),
          };
        },
        t("catalog.usedBy"),
        { width: "w-[18%]" },
      ),
    );
  }
  return columns;
}

export function CatalogPage({
  resource,
  permissions,
}: {
  resource: CatalogResource;
  permissions: readonly string[];
}) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const config = CONFIG[resource];
  // A connector sign-in comes back to this list with its result in the query.
  useConnectionCallback(resource === "connectors");
  const [state, setState] = useCatalogState(config);
  const [search, setSearch] = useState(state.q);
  const [recategorize, setRecategorize] = useState<CatalogRow | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  useEffect(() => setSearch(state.q), [state.q]);
  useEffect(() => {
    if (debouncedSearch !== state.q) setState({ q: debouncedSearch, page: 0 });
  }, [debouncedSearch, setState, state.q]);

  const query = useQuery({
    queryKey: ["catalog", resource, state],
    enabled: permissions.includes(config.permission),
    // Every narrowing, `health=not_ok` included, is the engine's — so the
    // total and the pages describe the narrowed list (catalog-model.ts).
    queryFn: () =>
      apiRequest<{
        items: CatalogRow[];
        total?: number;
        categories?: CategoryCount[];
      }>(`${config.endpoint}?${catalogListParams(resource, state, PAGE_SIZE)}`),
  });

  // Workflows name their connectors by slug; the detail route needs an id.
  const connectorIndex = useQuery({
    queryKey: ["catalog-connector-index"],
    enabled: resource === "workflows" && permissions.includes("connector:read"),
    queryFn: () =>
      apiRequest<{ items: ConnectorListItem[] }>(`/v1/connectors?limit=${RELATION_INDEX_LIMIT}`),
  });
  const connectorIdBySlug = useMemo(
    () => new Map((connectorIndex.data?.items ?? []).map((item) => [item.slug, item.id])),
    [connectorIndex.data],
  );

  // The engine answers "which connectors does this workflow use"; the connector
  // list needs the other direction, so one read is inverted here.
  const canReadWorkflows = permissions.includes("workflow:read");
  const workflowIndex = useQuery({
    queryKey: ["catalog-workflow-index"],
    enabled: resource === "connectors" && canReadWorkflows,
    queryFn: () =>
      apiRequest<{ items: WorkflowListItem[] }>(`/v1/workflows?limit=${RELATION_INDEX_LIMIT}`),
  });
  const workflowsByConnectorSlug = useMemo(
    () =>
      workflowsByConnector(
        (workflowIndex.data?.items ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          connectors: item.connectors,
        })),
      ),
    [workflowIndex.data],
  );

  const onCategory = useCallback((category: string) => setState({ category, page: 0 }), [setState]);
  const columns = useMemo(
    () =>
      catalogColumns(resource, t, dateTime, {
        connectorIdBySlug,
        workflowsByConnectorSlug,
        canReadWorkflows,
        onCategory,
      }),
    [
      resource,
      t,
      dateTime,
      connectorIdBySlug,
      workflowsByConnectorSlug,
      canReadWorkflows,
      onCategory,
    ],
  );
  const sorting: SortingState = [{ id: state.sort, desc: state.order === "desc" }];
  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? rows.length;
  const categories = query.data?.categories ?? [];
  const categoryCounts = useMemo(
    () => new Map(categories.map((entry) => [entry.category, entry.count])),
    [categories],
  );
  const title = t(config.titleKey);
  const canRecategorize = resource === "workflows" && permissions.includes("workflow:write");
  const hasActiveFilters =
    Boolean(state.q) ||
    state.status !== "all" ||
    state.category !== "all" ||
    Boolean(state.connector) ||
    state.health !== null;

  const showsZeroStateAction =
    rows.length === 0 &&
    !hasActiveFilters &&
    !query.isPending &&
    !query.error &&
    !query.failureReason;

  const resetFilters = useCallback(() => {
    setSearch("");
    setState({
      q: "",
      status: "all",
      category: "all",
      connector: "",
      health: null,
      page: 0,
    });
  }, [setState]);

  if (!permissions.includes(config.permission)) {
    return (
      <Page
        kind="list"
        surface="collection"
        testId={`catalog-${resource}`}
        scroll="page"
        header={<PageHeader title={title} />}
      >
        <DataState
          state="empty"
          line={t("resource.permission.description")}
          testId="resource-permission-alert"
        />
      </Page>
    );
  }

  const selects: FilterSelect[] = [
    {
      value: state.status,
      onChange: (status) => setState({ status, page: 0 }),
      label: t("catalog.filterStatus"),
      testId: "catalog-status-filter",
      options: [
        { value: "all", label: t("catalog.allStatuses") },
        ...config.statuses.map((status) => ({ value: status, label: statusLabel(t, status) })),
      ],
    },
  ];
  if (categories.length > 0)
    selects.push({
      value: state.category,
      onChange: (category) => setState({ category, page: 0 }),
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

  // One action, one place. With rows it heads the page; with none it stands in
  // the empty state, where the reader is looking — it used to stand in both,
  // the same button twice on one screen.
  const primaryAction = (testId: string) =>
    config.actionKey ? (
      <Button asChild size={testId === "catalog-empty-action" ? "sm" : "default"}>
        <a href={absolute(chatNewHref({ prompt: t(config.actionKey) }))} data-testid={testId}>
          <Bot data-icon="inline-start" />
          {t(config.actionKey)}
        </a>
      </Button>
    ) : undefined;

  return (
    <Page
      kind="list"
      surface="collection"
      testId={`catalog-${resource}`}
      scroll="content"
      header={
        <PageHeader
          title={title}
          // The header yields its action only to the one state that shows
          // the same action itself: a loaded, unfiltered, empty list. While
          // loading, after a failed read, or when a search matches nothing,
          // the empty state offers no "create" — hiding the header's there
          // left no way to start one until the reader cleared the filters.
          action={showsZeroStateAction ? undefined : primaryAction("catalog-primary-action")}
        />
      }
    >
      <DataTable
        columns={columns}
        data={rows}
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
            />
            {/* The narrowing a link brought, said out loud and removable. */}
            {resource === "connectors" && state.health === "not_ok" ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="catalog-health-filter"
                onClick={() => setState({ health: null, page: 0 })}
              >
                {t("catalog.healthNotOkFilter")}
              </Button>
            ) : null}
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
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
        refreshLabel={t("common.refresh")}
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
            title: t(config.emptyKey),
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
              page: 0,
            });
        }}
        onOpen={(row) => {
          const id = row.id;
          // A router navigation, as every other list opens its record: a full
          // page load would throw the cockpit away to show one record.
          if (typeof id === "string") void navigate({ to: recordHref(resource, id) });
        }}
        rowHref={(row) => (typeof row.id === "string" ? recordHref(resource, row.id) : null)}
        {...(canRecategorize
          ? {
              rowActions: (row: CatalogRow, index: number) => (
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  label={t("catalog.changeCategory")}
                  data-testid={`catalog-recategorize-${index}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setRecategorize(row);
                  }}
                >
                  <FolderTree />
                </IconButton>
              ),
            }
          : {})}
        page={state.page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={(page) => setState({ page })}
        previousLabel={t("catalog.previous")}
        nextLabel={t("catalog.next")}
        columnsLabel={t("catalog.columns")}
        recordsLabel={t("catalog.records")}
        loadedLabel={t("catalog.loaded", { count: rows.length })}
        actionsLabel={t("common.actions")}
      />
      {recategorize && (
        <RecategorizeDialog
          row={recategorize}
          categories={categories}
          counts={categoryCounts}
          onClose={() => setRecategorize(null)}
          onDone={() => {
            setRecategorize(null);
            void query.refetch();
          }}
        />
      )}
    </Page>
  );
}

/**
 * A workflow's category is its slug family, so moving it between blocks
 * renames the slug. The dialog shows the resulting slug and names the
 * consequence external clients see before anything is written.
 */
function RecategorizeDialog({
  row,
  categories,
  counts,
  onClose,
  onDone,
}: {
  row: CatalogRow;
  categories: CategoryCount[];
  counts: ReadonlyMap<string, number>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const slug = typeof row.slug === "string" ? row.slug : "";
  const currentCategory = typeof row.category === "string" ? row.category : UNCATEGORIZED;
  const id = typeof row.id === "string" ? row.id : "";
  const [target, setTarget] = useState(currentCategory);
  const nextSlug = recategorizedSlug(slug, currentCategory, target);
  const members = memberCountAfterMove(counts, currentCategory, target);
  const options = [
    ...new Set([...categories.map((entry) => entry.category), UNCATEGORIZED, currentCategory]),
  ];

  const move = useMutation({
    mutationFn: () =>
      apiRequest(`/v1/workflows/${encodeURIComponent(id)}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({ slug: nextSlug }),
      }),
    onSuccess: () => {
      toast.success(t("catalog.recategorized", { slug: nextSlug }));
      onDone();
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError && error.status === 409
          ? t("catalog.slugTaken", { slug: nextSlug })
          : t("catalog.recategorizeFailed"),
      );
    },
  });

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("catalog.changeCategory")}
      submit={{
        label: t("catalog.moveWorkflow"),
        pending: move.isPending,
        disabled: nextSlug === slug,
      }}
      onSubmit={() => move.mutate()}
      testId="catalog-recategorize-dialog"
    >
      <Select value={target} onValueChange={setTarget}>
        <SelectTrigger
          aria-label={t("catalog.changeCategory")}
          data-testid="catalog-recategorize-select"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((category, index) => (
              <SelectItem
                key={category}
                value={category}
                data-testid={`catalog-recategorize-option-${index}`}
              >
                {categoryLabel(category, t)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <p className="text-sm" data-testid="catalog-recategorize-slug">
        {t("catalog.resultingSlug", { slug: nextSlug })}
      </p>
      <p className="text-sm text-muted-foreground">{t("catalog.renameWarning")}</p>
      {target !== UNCATEGORIZED && members < MIN_CATEGORY_SIZE && (
        <p className="text-sm text-muted-foreground" data-testid="catalog-recategorize-hint">
          {t("catalog.categoryTooSmall", {
            count: String(MIN_CATEGORY_SIZE),
          })}
        </p>
      )}
    </FormDialog>
  );
}

function categoryLabel(category: string, t: ReturnType<typeof useI18n>["t"]): string {
  return humanizeCategory(category, t("catalog.categoryOther"));
}

export const CATALOG_RESOURCES = new Set<string>(Object.keys(CONFIG));
