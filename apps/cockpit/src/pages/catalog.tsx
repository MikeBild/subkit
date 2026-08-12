import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, type SortingState } from "@tanstack/react-table";
import { Bot, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import {
  type CockpitColumn,
  type CockpitTableFeatures,
  DataTable,
} from "@/components/cockpit/data-table";
import { IconButton } from "@/components/cockpit/icon-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";

type CatalogResource = "workflows" | "connectors" | "knowledge" | "skills" | "files";
type CatalogRow = Record<string, unknown>;

interface CatalogState {
  q: string;
  status: string;
  sort: string;
  order: "asc" | "desc";
  page: number;
}

interface CatalogConfig {
  endpoint: string;
  permission: string;
  titleKey: Parameters<ReturnType<typeof useI18n>["t"]>[0];
  descriptionKey: Parameters<ReturnType<typeof useI18n>["t"]>[0];
  emptyKey: Parameters<ReturnType<typeof useI18n>["t"]>[0];
  actionKey?: Parameters<ReturnType<typeof useI18n>["t"]>[0];
  defaultSort: string;
  statuses: string[];
}

const CONFIG: Record<CatalogResource, CatalogConfig> = {
  workflows: {
    endpoint: "/v1/workflows",
    permission: "workflow:read",
    titleKey: "resource.workflows.title",
    descriptionKey: "resource.workflows.description",
    emptyKey: "resource.workflows.empty",
    actionKey: "resource.workflows.action",
    defaultSort: "updated_at",
    statuses: ["draft", "active", "archived"],
  },
  connectors: {
    endpoint: "/v1/connectors",
    permission: "connector:read",
    titleKey: "resource.connectors.title",
    descriptionKey: "resource.connectors.description",
    emptyKey: "resource.connectors.empty",
    actionKey: "resource.connectors.action",
    defaultSort: "updated_at",
    statuses: ["enabled", "disabled", "ok", "degraded", "needs_reauth"],
  },
  knowledge: {
    endpoint: "/v1/knowledge-sources",
    permission: "knowledge:read",
    titleKey: "resource.knowledge.title",
    descriptionKey: "resource.knowledge.description",
    emptyKey: "resource.knowledge.empty",
    actionKey: "resource.knowledge.action",
    defaultSort: "updated_at",
    statuses: ["active", "inactive", "processing", "error"],
  },
  skills: {
    endpoint: "/v1/skills",
    permission: "skill:read",
    titleKey: "resource.skills.title",
    descriptionKey: "resource.skills.description",
    emptyKey: "resource.skills.empty",
    actionKey: "resource.skills.action",
    defaultSort: "updated_at",
    statuses: ["draft", "active", "archived"],
  },
  files: {
    endpoint: "/v1/files",
    permission: "file:read",
    titleKey: "resource.files.title",
    descriptionKey: "resource.files.description",
    emptyKey: "resource.files.empty",
    defaultSort: "created_at",
    statuses: ["pending", "uploading", "scanning", "ready", "failed", "expired"],
  },
};

const PAGE_SIZE = 25;

function parseState(config: CatalogConfig): CatalogState {
  const params = new URLSearchParams(window.location.search);
  const order = params.get("order");
  return {
    q: params.get("q") ?? "",
    status: params.get("status") ?? "all",
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

function stringValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return String(value.length);
  return String(value);
}

function bytes(value: unknown): string {
  if (typeof value !== "number") return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function catalogColumns(
  resource: CatalogResource,
  t: ReturnType<typeof useI18n>["t"],
  dateTime: ReturnType<typeof useI18n>["dateTime"],
): CockpitColumn<CatalogRow>[] {
  const helper = createColumnHelper<CockpitTableFeatures, CatalogRow>();
  const text = (id: string, field: string, label: string, sortable = true) =>
    helper.accessor((row) => row[field], {
      id,
      header: label,
      enableSorting: sortable,
      cell: ({ getValue }) => stringValue(getValue()),
    });
  const status = (id: string, field: string, label: string, sortable = true) =>
    helper.accessor((row) => row[field], {
      id,
      header: label,
      enableSorting: sortable,
      cell: ({ getValue }) => (
        <Badge variant="outline">{statusLabel(t, stringValue(getValue()))}</Badge>
      ),
    });
  const date = (id: string, field: string, label: string) =>
    helper.accessor((row) => row[field], {
      id,
      header: label,
      cell: ({ getValue }) => {
        const value = getValue();
        return typeof value === "string" ? dateTime(value) : "—";
      },
    });

  if (resource === "workflows") {
    return [
      text("name", "name", t("common.name")),
      status("lifecycle", "lifecycle", t("catalog.lifecycle")),
      text("version", "current_version", t("catalog.version"), false),
      text("connectors", "connectors", t("nav.connectors"), false),
      date("updated_at", "updated_at", t("catalog.updated")),
    ];
  }
  if (resource === "connectors") {
    return [
      text("name", "display_name", t("common.name")),
      text("driver", "driver", t("catalog.driver")),
      text("environment", "environment", t("catalog.environment")),
      status("health", "health_state", t("catalog.health"), false),
      helper.accessor((row) => row.enabled, {
        id: "enabled",
        header: t("catalog.enabled"),
        cell: ({ getValue }) => (
          <Badge variant="outline">{getValue() === true ? t("common.yes") : t("common.no")}</Badge>
        ),
      }),
      date("updated_at", "updated_at", t("catalog.updated")),
    ];
  }
  if (resource === "knowledge") {
    return [
      text("name", "name", t("common.name")),
      status("status", "status", t("resource.field.status")),
      text("source_type", "source_type", t("catalog.sourceType")),
      text("chunks", "chunk_count", t("catalog.chunks"), false),
      helper.accessor((row) => row.bytes_total, {
        id: "bytes_total",
        header: t("catalog.size"),
        cell: ({ getValue }) => bytes(getValue()),
      }),
      date("updated_at", "updated_at", t("catalog.updated")),
    ];
  }
  if (resource === "skills") {
    return [
      text("title", "title", t("resource.field.title")),
      status("status", "status", t("resource.field.status")),
      text("scope", "scope", t("resource.field.scope")),
      text("maturity", "maturity", t("catalog.maturity"), false),
      text("version", "version", t("catalog.version")),
      date("updated_at", "updated_at", t("catalog.updated")),
    ];
  }
  return [
    text("filename", "filename", t("catalog.filename")),
    status("status", "status", t("resource.field.status")),
    text("content_type", "content_type", t("catalog.contentType")),
    helper.accessor((row) => row.size_bytes, {
      id: "size_bytes",
      header: t("catalog.size"),
      cell: ({ getValue }) => bytes(getValue()),
    }),
    date("created_at", "created_at", t("resource.field.createdAt")),
  ];
}

export function CatalogPage({
  resource,
  permissions,
}: {
  resource: CatalogResource;
  permissions: readonly string[];
}) {
  const { t, dateTime } = useI18n();
  const config = CONFIG[resource];
  const [state, setState] = useCatalogState(config);
  const [search, setSearch] = useState(state.q);
  useEffect(() => setSearch(state.q), [state.q]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search !== state.q) setState({ q: search, page: 0 });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, setState, state.q]);

  const query = useQuery({
    queryKey: ["catalog", resource, state],
    enabled: permissions.includes(config.permission),
    queryFn: () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(state.page * PAGE_SIZE),
        sort: state.sort,
        order: state.order,
      });
      if (state.q) params.set("q", state.q);
      if (state.status !== "all") {
        if (resource === "connectors") {
          if (state.status === "enabled" || state.status === "disabled") {
            params.set("enabled", String(state.status === "enabled"));
          } else {
            params.set("health_state", state.status);
          }
        } else {
          params.set("status", state.status);
        }
      }
      return apiRequest<{ items: CatalogRow[]; total?: number }>(`${config.endpoint}?${params}`);
    },
  });
  const columns = useMemo(() => catalogColumns(resource, t, dateTime), [resource, t, dateTime]);
  const sorting: SortingState = [{ id: state.sort, desc: state.order === "desc" }];
  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? rows.length;
  const title = t(config.titleKey);

  if (!permissions.includes(config.permission)) {
    return (
      <main className="p-6">
        <Alert>
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid={`catalog-${resource}`}>
      <header className="flex flex-col gap-4 border-b p-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t(config.descriptionKey)}</p>
        </div>
        {config.actionKey && (
          <Button asChild>
            <a
              href={`/cockpit/chat/new?prompt=${encodeURIComponent(t(config.actionKey))}`}
              data-testid="catalog-primary-action"
            >
              <Bot data-icon="inline-start" />
              {t(config.actionKey)}
            </a>
          </Button>
        )}
      </header>
      <div className="flex flex-wrap items-center gap-3 border-b p-3">
        <InputGroup className="w-full sm:max-w-md">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("resource.search", { resource: title })}
            aria-label={t("resource.search", { resource: title })}
            data-testid="catalog-search"
          />
        </InputGroup>
        <Select value={state.status} onValueChange={(status) => setState({ status, page: 0 })}>
          <SelectTrigger
            className="w-44"
            aria-label={t("catalog.filterStatus")}
            data-testid="catalog-status-filter"
          >
            <SelectValue placeholder={t("catalog.allStatuses")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all" data-testid="catalog-status-all">
                {t("catalog.allStatuses")}
              </SelectItem>
              {config.statuses.map((status) => (
                <SelectItem key={status} value={status} data-testid={`catalog-status-${status}`}>
                  {statusLabel(t, status)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <IconButton
          variant="outline"
          label={t("common.refresh")}
          data-testid="catalog-refresh"
          onClick={() => query.refetch()}
        >
          <RefreshCw />
        </IconButton>
      </div>
      {query.isPending ? (
        <div className="flex flex-col gap-3 p-6" role="status">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : query.error ? (
        <Alert variant="destructive" className="m-6">
          <AlertTitle>{t("resource.loadFailed", { resource: title })}</AlertTitle>
          <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>{state.q ? t("resource.noMatches") : t(config.emptyKey)}</EmptyTitle>
            <EmptyDescription>{t("resource.broaderSearch")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          sorting={sorting}
          onSortingChange={(next) => {
            const first = next[0];
            if (first) setState({ sort: first.id, order: first.desc ? "desc" : "asc", page: 0 });
          }}
          onOpen={(row) => {
            const id = row.id;
            if (typeof id === "string") window.location.assign(`/cockpit/${resource}/${id}`);
          }}
          page={state.page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={(page) => setState({ page })}
          previousLabel={t("catalog.previous")}
          nextLabel={t("catalog.next")}
          columnsLabel={t("catalog.columns")}
          recordsLabel={t("catalog.records")}
          actionsLabel={t("common.actions")}
          openLabel={t("common.open")}
        />
      )}
    </main>
  );
}

export const CATALOG_RESOURCES = new Set<string>(Object.keys(CONFIG));
