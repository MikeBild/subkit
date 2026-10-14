import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, recordHref, runsHref } from "@/app/links";
import { CatalogOriginSummary, useCatalogOrigin } from "@/components/cockpit/catalog-categories";
import { CatalogNameCell } from "@/components/cockpit/catalog-metadata";
import { CreateAction } from "@/components/cockpit/create-choice";
import {
  Button,
  type CockpitColumn,
  DataTable,
  FilterBar,
  type FilterSelect,
  Page,
  PageHeader,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS, type Locale, pluralKey, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { type CursorPage, useInfiniteList } from "@/lib/use-infinite-list";
import { humanizeCategory } from "@/lib/workflow-category";
import {
  CATALOG_WORKFLOW_FILTER_STATUSES,
  catalogListParams,
  catalogOperatingStatus,
  OPERATING_STATUS_KEYS,
  type WorkflowStatusFilter,
} from "@/pages/catalog-model";
import { driverLabel } from "@/pages/connector-detail-model";
import {
  type ConnectorHealthFilter,
  connectorHealthFilterFromUrl,
  workflowsByConnector,
} from "@/pages/connectors-model";
import { triggerLabelKey } from "@/pages/workflows-model";

type CatalogResource = "workflows" | "connectors";
type CatalogRow = Record<string, unknown>;
type WorkflowListItem = components["schemas"]["WorkflowListItem"];

interface CatalogState {
  kind: "all" | "oauth" | "mcp" | "key";
  q: string;
  status: WorkflowStatusFilter;
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
  summaryKeys: { one: TranslationKey; other: TranslationKey };
  actionKey?: TranslationKey;
  defaultSort: string;
  statuses: readonly WorkflowStatusFilter[];
}

const CONFIG: Record<CatalogResource, CatalogConfig> = {
  workflows: {
    endpoint: "/v1/workflows",
    permission: "workflow:read",
    titleKey: "resource.workflows.title",
    emptyKey: "resource.workflows.empty",
    summaryKeys: {
      one: "resource.workflows.summary.one",
      other: "resource.workflows.summary.other",
    },
    actionKey: "resource.workflows.action",
    defaultSort: "updated_at",
    statuses: CATALOG_WORKFLOW_FILTER_STATUSES,
  },
  connectors: {
    endpoint: "/v1/connectors",
    permission: "connector:read",
    titleKey: "resource.connectors.title",
    emptyKey: "resource.connectors.empty",
    summaryKeys: {
      one: "resource.connectors.summary.one",
      other: "resource.connectors.summary.other",
    },
    actionKey: "resource.connectors.action",
    defaultSort: "updated_at",
    statuses: [],
  },
};

export function catalogCountLine(
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  resource: CatalogResource,
  count: number,
): string {
  const keys = CONFIG[resource].summaryKeys;
  return t(count === 1 ? keys.one : keys.other, { count });
}

const PAGE_SIZE = 25;
const RELATION_INDEX_LIMIT = 200;

function parseState(config: CatalogConfig): CatalogState {
  const params = new URLSearchParams(window.location.search);
  const order = params.get("order");
  return {
    q: params.get("q") ?? "",
    kind:
      config.endpoint === "/v1/connectors" &&
      ["oauth", "mcp", "key"].includes(params.get("kind") ?? "")
        ? (params.get("kind") as "oauth" | "mcp" | "key")
        : "all",
    status: config.statuses.includes(params.get("operating_status") as WorkflowStatusFilter)
      ? (params.get("operating_status") as WorkflowStatusFilter)
      : "all",
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
        if (next.kind !== "all") params.set("kind", next.kind);
        if (next.status !== "all") params.set("operating_status", next.status);
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
  resource: CatalogResource,
  t: ReturnType<typeof useI18n>["t"],
  dateTime: ReturnType<typeof useI18n>["dateTime"],
  relations: {
    workflowsByConnectorSlug: ReadonlyMap<string, { id: string; name: string }[]>;
    canReadWorkflows: boolean;
    locale: Locale;
  },
): CockpitColumn<CatalogRow>[] {
  const column = tableColumns<CatalogRow>({ t, dateTime });

  if (resource === "workflows") {
    return [
      column.custom(
        "name",
        (row) => row.name,
        t("common.name"),
        (row) => <CatalogNameCell name={stringField(row, "name") ?? ""} record={row} />,
        { sortable: true, width: "w-[38%]" },
      ),
      column.custom(
        "trigger",
        (row) => row.effective_trigger,
        t("catalog.trigger"),
        (row) => {
          const trigger = row.effective_trigger as WorkflowListItem["effective_trigger"];
          const schedule = row.schedule as WorkflowListItem["schedule"];
          const label = t(triggerLabelKey(trigger));
          return trigger.kind === "schedule" && schedule?.cron
            ? `${label} · ${cronWords(schedule.cron, t, LOCALE_TAGS[relations.locale])}`
            : label;
        },
        { width: "w-[18%]" },
      ),
      column.custom(
        "operating_status",
        (row) => row.operating_status,
        t("catalog.status"),
        (row, index) => {
          const status = catalogOperatingStatus(row.operating_status);
          return (
            <span className="flex min-w-0 flex-col items-start gap-1">
              <StatusBadge state={status} label={t(OPERATING_STATUS_KEYS[status])} />
              <HealthMark row={row} index={index} />
            </span>
          );
        },
        { width: "w-[26%]", interactive: true },
      ),
      column.date("last_executed_at", (row) => row.last_executed_at, t("catalog.lastRun"), {
        width: "w-[18%]",
      }),
    ];
  }

  return [
    column.custom(
      "name",
      (row) => row.display_name,
      t("common.name"),
      (row) => <CatalogNameCell name={stringField(row, "display_name") ?? ""} record={row} />,
      { sortable: true, width: "w-[34%]" },
    ),
    column.custom(
      "driver",
      (row) => row.driver,
      t("catalog.kind"),
      (row) => {
        const kind =
          row.driver === "mcp"
            ? t("catalog.kind.mcp")
            : driverLabel(stringField(row, "driver"), t) || MISSING;
        if (row.driver === "mcp")
          return typeof row.tools_count === "number"
            ? `${kind} · ${t(row.tools_count === 1 ? "connectorDetail.tools.count.one" : "connectorDetail.tools.count.other", { count: row.tools_count })}`
            : kind;
        const slug = stringField(row, "slug");
        if (!relations.canReadWorkflows || !slug) return kind;
        const users = relations.workflowsByConnectorSlug.get(slug)?.length ?? 0;
        return `${kind} · ${t(pluralKey("connectors.usedByCount", users), { count: users })}`;
      },
      { width: "w-[30%]" },
    ),
    column.custom(
      "health",
      (row) => row.health_state,
      t("catalog.status"),
      (row) => {
        const state = row.enabled === false ? "disabled" : stringField(row, "health_state");
        return state ? <StatusBadge state={state} label={statusLabel(t, state)} /> : MISSING;
      },
      { width: "w-[18%]" },
    ),
    column.date("last_tested_at", (row) => row.last_tested_at, t("catalog.tested"), {
      width: "w-[18%]",
    }),
  ];
}

export function CatalogPage({
  resource,
  permissions,
}: {
  resource: CatalogResource;
  permissions: readonly string[];
}) {
  const { t, dateTime, locale } = useI18n();
  const navigate = useNavigate();
  const config = CONFIG[resource];
  const [state, setState] = useCatalogState(config);
  const [search, setSearch] = useState(state.q);
  const origin = useCatalogOrigin();
  const debouncedSearch = useDebouncedValue(search);
  useEffect(() => setSearch(state.q), [state.q]);
  useEffect(() => {
    if (debouncedSearch !== state.q) setState({ q: debouncedSearch });
  }, [debouncedSearch, setState, state.q]);

  const params = useMemo(
    () => ({ ...catalogListParams(resource, state), description_source: origin.descriptionSource }),
    [resource, state, origin.descriptionSource],
  );
  const list = useInfiniteList<CatalogRow, CatalogListPage>(config.endpoint, params, {
    limit: PAGE_SIZE,
    enabled: permissions.includes(config.permission),
    queryKey: ["catalog", resource, params],
  });
  const query = list.query;

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

  const columns = useMemo(
    () =>
      catalogColumns(resource, t, dateTime, {
        workflowsByConnectorSlug,
        canReadWorkflows,
        locale,
      }),
    [resource, t, dateTime, workflowsByConnectorSlug, canReadWorkflows, locale],
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
    state.health !== null ||
    state.kind !== "all" ||
    origin.active;

  const showsZeroStateAction =
    rows.length === 0 &&
    !hasActiveFilters &&
    !query.isPending &&
    !query.error &&
    !query.failureReason;

  const resetFilters = useCallback(() => {
    setSearch("");
    origin.setValue("all");
    setState({
      q: "",
      status: "all",
      category: "all",
      connector: "",
      health: null,
      kind: "all",
    });
  }, [setState, origin.setValue]);

  if (!permissions.includes(config.permission)) {
    return (
      <Page
        kind="list"
        surface="collection"
        testId={`catalog-${resource}`}
        scroll="page"
        header={<PageHeader title={title} />}
      >
        <ForbiddenState />
      </Page>
    );
  }

  const selects: FilterSelect[] = [];
  if (resource === "connectors")
    selects.push({
      value: state.kind,
      onChange: (kind) => setState({ kind: kind as CatalogState["kind"] }),
      label: t("catalog.kind"),
      testId: "catalog-kind-filter",
      options: [
        { value: "all", label: t("catalog.kindAll") },
        { value: "oauth", label: t("catalog.kind.oauth") },
        { value: "mcp", label: t("catalog.kind.mcp") },
        { value: "key", label: t("catalog.kind.key") },
      ],
    });
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
  if (resource === "workflows")
    selects.push({
      value: state.status,
      onChange: (status) => setState({ status: status as WorkflowStatusFilter }),
      label: t("catalog.filterStatus"),
      testId: "catalog-status-filter",
      options: [
        { value: "all", label: t("catalog.allStatuses") },
        ...config.statuses.map((status) => ({
          value: status,
          label: t(OPERATING_STATUS_KEYS[catalogOperatingStatus(status)]),
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
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {rows.length > 0 || hasActiveFilters ? (
          <CatalogOriginSummary
            text={catalogCountLine(t, resource, total)}
            kind={resource === "workflows" ? "workflow" : "connector"}
            origin={origin}
            testId="catalog-summary"
          />
        ) : null}
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
          pickColumns={false}
          recordsLabel={t("catalog.records")}
          actionsLabel={t("common.actions")}
        />
      </div>
    </Page>
  );
}

function categoryLabel(category: string, t: ReturnType<typeof useI18n>["t"]): string {
  return humanizeCategory(category, t("catalog.categoryOther"));
}

export const CATALOG_RESOURCES = new Set<string>(Object.keys(CONFIG));
