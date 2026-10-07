import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { useNameIndex } from "@/app/use-decisions";
import {
  Button,
  type CockpitColumn,
  CodeBlock,
  CollapsibleSection,
  DataState,
  DataTable,
  type Fact,
  FactList,
  FilterBar,
  Page,
  PageHeader,
  RecordSheet,
  Section,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { type ListParams, useInfiniteList } from "@/lib/use-infinite-list";
import { windowFilterLabel } from "@/lib/window-filter";
import {
  AUDIT_LINK_KEYS,
  type AuditEvidenceKind,
  type AuditScope,
  auditActionLabel,
  auditActorName,
  auditDetailFacts,
  auditEvidenceBlocks,
  auditFilterFromUrl,
  auditLinkParams,
  auditMetadataFacts,
  auditResourceHref,
  auditResourceLabel,
  auditResultFromUrl,
  auditResultLabel,
  auditScopeParams,
  auditSearchActions,
  canReadDirectory,
  isAuditEntry,
  isAuditScope,
  NO_AUDIT_LINK,
  searchedActionParams,
  shortIdentifier,
} from "@/pages/audit-model";

type AuditEntry = components["schemas"]["AuditEntry"];
const RESULTS = ["success", "denied", "error"] as const;
const SCOPES = ["all", "operations", "decisions"] as const satisfies readonly AuditScope[];

const SCOPE_KEYS: Record<(typeof SCOPES)[number], TranslationKey> = {
  all: "audit.scope.all",
  operations: "audit.scope.operations",
  decisions: "audit.scope.decisions",
};

const EVIDENCE_KEYS: Record<AuditEvidenceKind, TranslationKey> = {
  before: "audit.detail.before",
  after: "audit.detail.after",
};

function AuditDetail({
  entry,
  directory,
}: {
  entry: AuditEntry;
  directory: ReadonlyMap<string, string>;
}) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const names = useNameIndex(session.permissions, true);
  const detail = useQuery({
    queryKey: ["audit-entry", entry.id],
    queryFn: () => apiRequest<unknown>(`/v1/audit-log/${encodeURIComponent(entry.id)}`),
    retry: false,
  });
  const current = isAuditEntry(detail.data) ? detail.data : entry;
  const facts = auditDetailFacts(current, t, dateTime, directory);
  const evidence = auditEvidenceBlocks(current);
  const extra = auditMetadataFacts(current.metadata, t, names);
  const toFact = (fact: (typeof facts)[number]): Fact => ({
    label: fact.label,
    value:
      fact.value === null ? (
        MISSING
      ) : fact.mono ? (
        <span className="font-mono text-xs break-all" title={fact.value}>
          {shortIdentifier(fact.value)}
        </span>
      ) : (
        fact.value
      ),
  });

  return (
    <>
      <FactList
        testId="audit-detail-facts"
        items={facts.filter((fact) => !fact.mono).map(toFact)}
      />

      {detail.error ? (
        <DataState
          state="error"
          line={t("audit.detail.refreshFailed")}
          onRetry={() => void detail.refetch()}
          testId="audit-detail-stale"
        />
      ) : null}

      {extra.facts.length > 0 ? (
        <Section label={t("audit.detail.metadata")} testId="audit-detail-metadata">
          <FactList
            testId="audit-detail-metadata-facts"
            items={extra.facts.map((fact) => ({
              label: fact.label,
              value: fact.href ? (
                <a
                  href={absolute(fact.href)}
                  className="underline-offset-4 hover:underline"
                  data-testid={`audit-detail-meta-${fact.key}`}
                >
                  {fact.value}
                </a>
              ) : (
                fact.value
              ),
            }))}
          />
        </Section>
      ) : null}

      {evidence.map((block) => (
        <CodeBlock
          key={block.kind}
          label={t(EVIDENCE_KEYS[block.kind])}
          lang="json"
          code={block.text}
          testId={`audit-detail-${block.kind}`}
        />
      ))}

      <CollapsibleSection label={t("audit.detail.technical")} testId="audit-detail-technical">
        <FactList items={facts.filter((fact) => fact.mono).map(toFact)} />
        {extra.rest ? (
          <CodeBlock
            label={t("audit.detail.metadataRest")}
            lang="json"
            code={extra.rest}
            testId="audit-detail-metadata-rest"
          />
        ) : null}
      </CollapsibleSection>
    </>
  );
}

export function AuditPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const live = useLiveQueryOptions();
  const allowed = session.permissions.includes("audit:read");
  const title = t("resource.audit.title");
  const [result, setResult] = useState<string>(
    () => auditResultFromUrl(window.location.search) ?? "all",
  );
  const [linked, setLinked] = useState(() => auditFilterFromUrl(window.location.search));
  const [scope, setScope] = useState<AuditScope>(
    () =>
      linked.scope ??
      (linked.resourceType || linked.traceId || linked.actions.length > 0 ? "all" : "decisions"),
  );
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  const directoryReadable = canReadDirectory(session);
  const people = useQuery({
    queryKey: ["audit-directory", "people"],
    enabled: allowed && directoryReadable,
    queryFn: () =>
      apiRequest<{ items?: Array<{ id: string; email?: string; name?: string }> }>(
        "/v1/identity/users?limit=200",
      ),
    ...live,
  });
  const accounts = useQuery({
    queryKey: ["audit-directory", "system-accounts"],
    enabled: allowed && directoryReadable,
    queryFn: () =>
      apiRequest<{ items?: Array<{ id: string; name?: string }> }>("/v1/identity/system-accounts"),
    ...live,
  });
  const directory = useMemo(() => {
    const byId = new Map<string, string>();
    for (const item of people.data?.items ?? []) {
      const label = item.name?.trim() || item.email?.trim();
      if (label) byId.set(item.id, label);
    }
    for (const item of accounts.data?.items ?? []) {
      const label = item.name?.trim();
      if (label) byId.set(item.id, label);
    }
    return byId;
  }, [people.data, accounts.data]);

  const params = useMemo<ListParams>(
    () => ({
      ...(result !== "all" ? { result } : {}),
      ...auditScopeParams(scope),
      ...auditLinkParams(linked),
    }),
    [result, scope, linked],
  );
  const searched = useMemo(() => {
    const needle = debouncedSearch.trim();
    return searchedActionParams(
      params as Record<string, string>,
      needle ? auditSearchActions(needle, t) : null,
    );
  }, [params, debouncedSearch, t]);
  const list = useInfiniteList<AuditEntry>("/v1/audit-log", searched ?? params, {
    enabled: allowed && searched !== null,
  });
  const query = list.query;
  const rows = searched === null ? [] : list.items;
  const pending = searched !== null && query.isPending;
  const actionName = (action: string) => {
    const label = auditActionLabel(action);
    return label.kind === "named" ? t(label.key) : label.value;
  };

  const columns = useMemo<CockpitColumn<AuditEntry>[]>(() => {
    const column = tableColumns<AuditEntry>({ t, dateTime });
    return [
      column.custom(
        "action",
        (entry) => entry.action,
        t("audit.column.event"),
        (entry) => {
          const label = auditActionLabel(entry.action);
          const kind = auditResourceLabel(entry.resource_type, t).text;
          return label.kind === "named" ? (
            <span className="block break-words" title={entry.action}>
              {t(label.key)}
              <span className="text-muted-foreground"> · {kind}</span>
            </span>
          ) : (
            <span className="block break-words" title={entry.action}>
              <span className="font-mono text-xs" data-testid="audit-action-raw">
                {label.value}
              </span>
              <span className="text-muted-foreground"> · {kind}</span>
            </span>
          );
        },
        { width: "w-[44%]" },
      ),
      column.custom(
        "actor",
        (entry) => entry.actor_id ?? entry.actor_type,
        t("audit.column.actor"),
        (entry) => {
          const actor = auditActorName(entry, directory, t);
          return actor ? (
            <span className="block truncate" data-testid="audit-actor">
              <LabelText label={actor} />
            </span>
          ) : (
            MISSING
          );
        },
        { width: "w-[20%]" },
      ),
      column.custom(
        "result",
        (entry) => entry.result,
        t("audit.column.result"),
        (entry) => (
          <StatusBadge state={entry.result} label={auditResultLabel(entry.result, t).text} />
        ),
        { width: "w-[16%]" },
      ),
      column.date("ts", (entry) => entry.ts, t("audit.column.time"), { width: "w-[20%]" }),
    ];
  }, [t, dateTime, directory]);

  const selectedAction = selected ? auditActionLabel(selected.action) : null;
  const selectedHref = selected
    ? auditResourceHref(selected.resource_type, selected.resource_id)
    : null;

  const hasActiveFilters =
    Boolean(debouncedSearch.trim()) ||
    result !== "all" ||
    scope !== "decisions" ||
    linked.traceId !== null ||
    linked.resourceType !== null ||
    linked.actions.length > 0 ||
    linked.tsFrom !== null ||
    linked.tsTo !== null;
  const forgetInAddress = useCallback((keys: readonly string[]) => {
    const params = new URLSearchParams(window.location.search);
    for (const key of keys) params.delete(key);
    const rest = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}`,
    );
  }, []);
  const lift = useCallback(
    (part: Partial<typeof linked>, keys: readonly string[]) => {
      setLinked((current) => ({ ...current, ...part }));
      forgetInAddress(keys);
    },
    [forgetInAddress],
  );
  const resetFilters = useCallback(() => {
    setSearch("");
    setResult("all");
    setScope("decisions");
    setLinked(NO_AUDIT_LINK);
    forgetInAddress([
      ...AUDIT_LINK_KEYS.resource,
      ...AUDIT_LINK_KEYS.trace,
      ...AUDIT_LINK_KEYS.actions,
      ...AUDIT_LINK_KEYS.window,
      "scope",
    ]);
  }, [forgetInAddress]);

  const header = <PageHeader title={title} />;

  if (!allowed)
    return (
      <Page kind="list" surface="audit" testId="resource-audit" scroll="page" header={header}>
        <ForbiddenState />
      </Page>
    );

  return (
    <Page kind="list" surface="audit" testId="resource-audit" scroll="content" header={header}>
      <div className="shrink-0 pb-3">
        <SummaryLine
          testId="audit-summary"
          text={
            <span data-testid="audit-scope-note">
              {pending
                ? t("audit.summary")
                : t(
                    list.infinite.hasNextPage
                      ? "audit.countMore"
                      : rows.length === 1
                        ? "audit.count.one"
                        : "audit.count",
                    { count: rows.length },
                  )}
            </span>
          }
          help={t("audit.coverageNote")}
        />
      </div>
      <DataTable
        columns={columns}
        data={rows}
        toolbar={
          <>
            <FilterBar
              search={{
                value: search,
                onChange: setSearch,
                placeholder: t("audit.search"),
                testId: "audit-search",
              }}
              selects={[
                {
                  value: scope,
                  label: t("audit.filterScope"),
                  testId: "audit-scope-filter",
                  onChange: (next) => {
                    if (!isAuditScope(next)) return;
                    setScope(next);
                  },
                  options: SCOPES.map((value) => ({ value, label: t(SCOPE_KEYS[value]) })),
                },
                {
                  value: result,
                  label: t("audit.filterResult"),
                  testId: "audit-result-filter",
                  onChange: setResult,
                  options: [
                    { value: "all", label: t("audit.allResults") },
                    ...RESULTS.map((value) => ({
                      value,
                      label: auditResultLabel(value, t).text,
                    })),
                  ],
                },
              ]}
            />
            {linked.resourceType ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="audit-resource-filter"
                onClick={() =>
                  lift({ resourceType: null, resourceId: null }, AUDIT_LINK_KEYS.resource)
                }
              >
                {t(linked.resourceId ? "audit.recordFilter" : "audit.resourceFilter", {
                  resource: auditResourceLabel(linked.resourceType, t).text,
                })}
              </Button>
            ) : null}
            {linked.traceId ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="audit-trace-filter"
                onClick={() => lift({ traceId: null }, AUDIT_LINK_KEYS.trace)}
                title={linked.traceId}
              >
                {t("audit.traceFilter")}
              </Button>
            ) : null}
            {linked.actions.length > 0 ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="audit-action-filter"
                onClick={() => lift({ actions: [] }, AUDIT_LINK_KEYS.actions)}
                title={linked.actions.map((action) => actionName(action)).join(", ")}
              >
                {linked.actions.length === 1
                  ? t("audit.actionFilterOne", { action: actionName(linked.actions[0] ?? "") })
                  : t("audit.actionFilter", { count: String(linked.actions.length) })}
              </Button>
            ) : null}
            {linked.tsFrom || linked.tsTo ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="audit-window-filter"
                onClick={() => lift({ tsFrom: null, tsTo: null }, AUDIT_LINK_KEYS.window)}
              >
                {windowFilterLabel(linked.tsFrom, linked.tsTo, t, dateTime)}
              </Button>
            ) : null}
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
        pending={pending}
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
        onOpen={(entry) => setSelected(entry)}
        rowLabel={(entry) =>
          t("audit.openEntry", {
            action: actionName(entry.action),
            resource: auditResourceLabel(entry.resource_type, t).text,
            time: dateTime(entry.ts),
          })
        }
        infinite={list.infinite}
        getRowId={(entry) => entry.id}
        columnsLabel={t("catalog.columns")}
        recordsLabel={t("catalog.records")}
        actionsLabel={t("common.actions")}
      />

      <RecordSheet
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        testId="audit-detail"
        closeTestId="audit-detail-close"
        titleTestId="audit-detail-title"
        title={
          selectedAction === null ? (
            title
          ) : selectedAction.kind === "named" ? (
            t(selectedAction.key)
          ) : (
            <span className="font-mono text-base" data-testid="audit-detail-action-raw">
              {selectedAction.value}
            </span>
          )
        }
        badge={
          selected ? (
            <StatusBadge
              state={selected.result}
              label={auditResultLabel(selected.result, t).text}
            />
          ) : null
        }
        action={
          selected && selectedHref ? (
            <Button variant="outline" asChild>
              <a href={selectedHref} data-testid="audit-detail-open">
                {selected.resource_type === "execution"
                  ? t("audit.detail.openRun")
                  : t("audit.detail.openRecord", {
                      resource: auditResourceLabel(selected.resource_type, t).text,
                    })}
              </a>
            </Button>
          ) : null
        }
      >
        {selected ? <AuditDetail entry={selected} directory={directory} /> : null}
      </RecordSheet>
    </Page>
  );
}
