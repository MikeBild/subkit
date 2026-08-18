import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import { type CockpitColumn, DataTable } from "@/components/cockpit/data-table";
import { PageFrame } from "@/components/cockpit/page-frame";
import { MISSING, type Relation, tableColumns } from "@/components/cockpit/table-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { actorTypeKey, auditResourceHref, resourceTypeKey } from "@/pages/audit-model";

type AuditEntry = components["schemas"]["AuditEntry"];
type AuditList = components["schemas"]["AuditLogListResponse"];

const PAGE_SIZE = 50;
const RESULTS = ["success", "denied", "error"] as const;

const RESULT_KEYS: Record<string, TranslationKey> = {
  success: "audit.result.success",
  denied: "audit.result.denied",
  error: "audit.result.error",
};

function resultLabel(result: string, t: ReturnType<typeof useI18n>["t"]): string {
  const key = RESULT_KEYS[result];
  return key ? t(key) : t("common.unknown");
}

/**
 * The audit log is the one list the engine pages by cursor: it has no `total`
 * and no offset, only `before`. The page therefore keeps the cursor it was
 * handed for each step and never claims a count it was not given.
 */
export function AuditPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("audit:read");
  const title = t("resource.audit.title");
  const [result, setResult] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const debouncedSearch = useDebouncedValue(search);

  const query = useQuery({
    queryKey: ["audit", result, page, cursors[page]],
    enabled: allowed,
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (result !== "all") params.set("result", result);
      const before = cursors[page];
      if (before) params.set("before", before);
      return apiRequest<AuditList>(`/v1/audit-log?${params}`);
    },
  });

  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  // The engine matches `action` exactly, so a free-text box cannot become a
  // query parameter without lying about what it searched.
  const rows = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((entry) => entry.action.toLowerCase().includes(needle));
  }, [items, debouncedSearch]);

  const columns = useMemo<CockpitColumn<AuditEntry>[]>(() => {
    const column = tableColumns<AuditEntry>({ t, dateTime });
    return [
      column.date("ts", (entry) => entry.ts, t("audit.column.time"), { width: "w-[18%]" }),
      column.text("action", (entry) => entry.action, t("resource.field.action"), {
        width: "w-[24%]",
      }),
      column.custom(
        "result",
        (entry) => entry.result,
        t("audit.column.result"),
        (entry) => (
          <Badge variant={entry.result === "success" ? "outline" : "destructive"}>
            {resultLabel(entry.result, t)}
          </Badge>
        ),
        { width: "w-[11%]" },
      ),
      // Actor and resource read as words. The ids behind them are routing keys
      // and only ever travel inside an href.
      column.custom(
        "actor",
        (entry) => entry.actor_type,
        t("audit.column.actor"),
        (entry) => t(actorTypeKey(entry.actor_type)),
        { width: "w-[13%]" },
      ),
      column.link(
        "resource",
        (entry): Relation | null => ({
          href: auditResourceHref(entry.resource_type, entry.resource_id),
          label: t(resourceTypeKey(entry.resource_type)),
        }),
        t("audit.column.resource"),
        { width: "w-[14%]" },
      ),
      column.custom(
        "reason",
        (entry) => entry.reason,
        t("audit.column.reason"),
        (entry) => entry.reason ?? MISSING,
        { width: "w-[20%]" },
      ),
    ];
  }, [t, dateTime]);

  const hasActiveFilters = Boolean(debouncedSearch.trim()) || result !== "all";
  const resetFilters = useCallback(() => {
    setSearch("");
    setResult("all");
    setPage(0);
    setCursors([undefined]);
  }, []);

  if (!allowed)
    return (
      <main className="p-6" data-testid="resource-audit">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  return (
    <PageFrame
      testId="resource-audit"
      title={title}
      description={t("resource.audit.description")}
      scroll="content"
    >
      <DataTable
        columns={columns}
        data={rows}
        toolbar={
          <>
            <InputGroup className="w-full sm:max-w-xs">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("audit.search")}
                aria-label={t("audit.search")}
                data-testid="audit-search"
              />
            </InputGroup>
            <Select
              value={result}
              onValueChange={(next) => {
                setResult(next);
                setPage(0);
                setCursors([undefined]);
              }}
            >
              <SelectTrigger
                className="w-44"
                aria-label={t("audit.filterResult")}
                data-testid="audit-result-filter"
              >
                <SelectValue placeholder={t("audit.allResults")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all" data-testid="audit-result-all">
                    {t("audit.allResults")}
                  </SelectItem>
                  {RESULTS.map((value) => (
                    <SelectItem key={value} value={value} data-testid={`audit-result-${value}`}>
                      {resultLabel(value, t)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="audit-clear-filters"
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
        pending={query.isPending}
        error={
          query.error
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
            title: t("resource.audit.empty"),
            description: t("resource.emptyDescription"),
          },
          filtered: {
            title: t("resource.noMatches"),
            description: t("resource.broaderSearch"),
            resetLabel: t("catalog.clearFilters"),
            onReset: resetFilters,
          },
        }}
        hasActiveFilters={hasActiveFilters}
        sorting={[] as SortingState}
        onSortingChange={() => {}}
        mode="cursor"
        page={page}
        pageSize={PAGE_SIZE}
        hasNext={Boolean(query.data?.next_cursor)}
        onPageChange={(next) => {
          if (next > page) {
            const cursor = query.data?.next_cursor;
            if (!cursor) return;
            setCursors((current) => {
              const copy = [...current];
              copy[next] = cursor;
              return copy;
            });
          }
          setPage(Math.max(0, next));
        }}
        previousLabel={t("catalog.previous")}
        nextLabel={t("catalog.next")}
        columnsLabel={t("catalog.columns")}
        recordsLabel={t("catalog.records")}
        loadedLabel={t("catalog.loaded", { count: rows.length })}
        actionsLabel={t("common.actions")}
        openLabel={t("common.open")}
      />
    </PageFrame>
  );
}
