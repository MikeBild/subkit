import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, recordHref, runsHref, workflowsHref } from "@/app/links";
import { CreateAction } from "@/components/cockpit/create-choice";
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
import { type CursorPage, useInfiniteList } from "@/lib/use-infinite-list";
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

type CatalogResource = "workflows" | "connectors";
type CatalogRow = Record<string, unknown>;
type ConnectorListItem = components["schemas"]["ConnectorListItem"];
type WorkflowListItem = components["schemas"]["WorkflowListItem"];

interface CatalogState {
  q: string;
  status: string;
  category: string;
  connector: string;
  health: ConnectorHealthFilter | null;
  sort: string;
  order: "asc" | "desc";
}

interface CategoryCount {
  category: string;
  count: number;
}

interface CatalogListPage extends CursorPage<CatalogRow> {
  categories?: CategoryCount[];
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

function HealthMark({ row, index }: { row: CatalogRow; index: number }) {
  const { t } = useI18n();
  const state = stringField(row, "health_state");
  const id = stringField(row, "id");
  if (!state || state === "ok") return null;
  const tone = state === "degraded" ? "bg-destructive" : "bg-warning";
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
        (row) => t(triggerLabelKey(row.effective_trigger as WorkflowListItem["effective_trigger"])),
        { width: "w-[11%]" },
      ),
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
    column.text("name", (row) => row.display_name, t("common.name"), {
      sortable: true,
      width: "w-[23%]",
    }),
    column.status("health", (row) => row.health_state, t("catalog.health"), {
      width: "w-[18%]",
    }),
    column.custom(
      "enabled",
      (row) => row.enabled,
      t("catalog.enabled"),
      (row) => (row.enabled === true ? t("common.yes") : t("common.no")),
      { sortable: true, width: "w-[10%]" },
    ),
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
  useConnectionCallback(resource === "connectors");
  const [state, setState] = useCatalogState(config);
  const [search, setSearch] = useState(state.q);
  const debouncedSearch = useDebouncedValue(search);
  useEffect(() => setSearch(state.q), [state.q]);
  useEffect(() => {
    if (debouncedSearch !== state.q) setState({ q: debouncedSearch });
  }, [debouncedSearch, setState, state.q]);

  const params = useMemo(() => catalogListParams(resource, state), [resource, state]);
  const list = useInfiniteList<CatalogRow, CatalogListPage>(config.endpoint, params, {
    limit: PAGE_SIZE,
    enabled: permissions.includes(config.permission),
    queryKey: ["catalog", resource, params],
  });
  const query = list.query;

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

  const onCategory = useCallback((category: string) => setState({ category }), [setState]);
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
  const rows = list.items;
  const total = list.total ?? rows.length;
  const categories = useMemo(() => list.first?.categories ?? [], [list.first]);
  const title = t(config.titleKey);
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
      onChange: (status) => setState({ status }),
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

  const primaryAction = (testId: string) =>
    (resource === "workflows" && permissions.includes("workflow:write")) ||
    (resource === "connectors" && permissions.includes("connector:write")) ? (
      <CreateAction
        kind={resource === "workflows" ? "workflow" : "connector"}
        canChat={permissions.includes("conversation:write")}
        size={testId === "catalog-empty-action" ? "sm" : "default"}
        testId={testId}
      />
    ) : config.actionKey ? (
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
            {resource === "connectors" && state.health === "not_ok" ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="catalog-health-filter"
                onClick={() => setState({ health: null })}
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
            });
        }}
        onOpen={(row) => {
          const id = row.id;
          if (typeof id === "string") void navigate({ to: recordHref(resource, id) });
        }}
        rowHref={(row) => (typeof row.id === "string" ? recordHref(resource, row.id) : null)}
        total={total}
        infinite={list.infinite}
        columnsLabel={t("catalog.columns")}
        recordsLabel={t("catalog.records")}
        actionsLabel={t("common.actions")}
      />
    </Page>
  );
}

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

export function WorkflowRecategorize({
  record,
  onClose,
}: {
  record: CatalogRow;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["workflow-categories"],
    queryFn: () => apiRequest<{ categories?: CategoryCount[] }>("/v1/workflows?limit=1"),
  });
  const categories = useMemo(() => query.data?.categories ?? [], [query.data]);
  const counts = useMemo(
    () => new Map(categories.map((entry) => [entry.category, entry.count])),
    [categories],
  );
  return (
    <RecategorizeDialog
      row={record}
      categories={categories}
      counts={counts}
      onClose={onClose}
      onDone={() => {
        void client.invalidateQueries({ queryKey: ["catalog-detail", "workflows"] });
        void client.invalidateQueries({ queryKey: ["catalog", "workflows"] });
        onClose();
      }}
    />
  );
}

function categoryLabel(category: string, t: ReturnType<typeof useI18n>["t"]): string {
  return humanizeCategory(category, t("catalog.categoryOther"));
}

export const CATALOG_RESOURCES = new Set<string>(Object.keys(CONFIG));
